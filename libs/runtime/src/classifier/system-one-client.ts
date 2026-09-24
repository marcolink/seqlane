import { randomUUID } from "node:crypto";
import type {
  ClassifierRequest,
  ClassifierRequestInput,
  ClassifierResult,
  JsonValue,
} from "@seqlane/core";
import { classifierRequestSchema, plainRecordSchema } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import { z } from "zod";
import {
  parseBoundedJson,
  parseBoundedJsonDocument,
  CLASSIFIER_MAX_BODY_BYTES,
  CLASSIFIER_MAX_STATE_BYTES,
  serializeBoundedJson,
  serializeBoundedJsonDocument,
} from "./payload-limits.js";
import { mapSystemOneResponse } from "./system-one-response.js";
import {
  ClassifierFailure,
  type ClassifierObservationSink,
  type ClassifierTaskRunner,
  type PrivateClassifierConnection,
} from "./types.js";
import {
  privateClassifierConnectionSchema,
  type ValidatedClassifierConnection,
} from "./connection.js";
import { emitFailedSystemOneObservation } from "./system-one-observation.js";

export const CLASSIFIER_TRANSPORT_BUDGET_MS = 20_000;

const classifierRequestEnvelopeSchema = z
  .strictObject({
    state: z.unknown(),
    questions: plainRecordSchema.pipe(
      z.record(
        z.string(),
        plainRecordSchema.pipe(z.record(z.string(), z.unknown())),
      ),
    ),
  })
  .superRefine((request, context) => {
    const questionIds = Object.keys(request.questions);
    if (questionIds.length > 256) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Classifier requests support at most 256 questions",
      });
    }
    for (const id of questionIds) {
      if (Buffer.byteLength(id, "utf8") > 256) {
        context.addIssue({
          code: "custom",
          path: ["questions", id],
          message: "Classifier question IDs cannot exceed 256 UTF-8 bytes",
        });
      }
    }
  });

const classifierStateSizeSchema = z.custom<unknown>((value) => {
  try {
    serializeBoundedJson(value, "state", CLASSIFIER_MAX_STATE_BYTES);
    return true;
  } catch {
    return false;
  }
}, "Classifier state exceeds the 768 KiB limit");

const systemOneNoulRequestSchema = classifierRequestSchema.superRefine(
  (request, context) => {
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.kind !== "noul") {
        context.addIssue({
          code: "custom",
          path: ["questions", id, "kind"],
          message: "System One Choice and Score mapping is not implemented yet",
        });
      }
    }
  },
);

const responseTextSchema = z.string().superRefine((text, context) => {
  if (Buffer.byteLength(text, "utf8") > CLASSIFIER_MAX_BODY_BYTES) {
    context.addIssue({
      code: "custom",
      message: "Classifier response is too large",
    });
  }
});

const responseJsonSchema = z.string().transform((text, context): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    context.addIssue({
      code: "custom",
      message: "Classifier response is not valid JSON",
    });
    return z.NEVER;
  }
});

function validateConnection(
  connection: PrivateClassifierConnection | undefined,
): ValidatedClassifierConnection {
  const parsed = privateClassifierConnectionSchema.safeParse(connection);
  if (!parsed.success) {
    throw invalidConnectionFailure();
  }
  return parsed.data;
}

function invalidConnectionFailure(): ClassifierFailure {
  return new ClassifierFailure(
    "configuration",
    "Classifier connection must contain a safe URL, model, and required API key",
  );
}

function requestModelFor(
  connection: PrivateClassifierConnection | undefined,
): string {
  if (
    connection === undefined ||
    typeof connection.model !== "string" ||
    connection.model.trim().length === 0
  ) {
    throw invalidConnectionFailure();
  }
  return connection.model.trim();
}

function safeTransportCause(
  cause: unknown,
  apiKey?: string,
  seen = new Set<Error>(),
): unknown {
  if (cause instanceof Error) {
    if (seen.has(cause))
      return new Error("Classifier transport cause redacted");
    seen.add(cause);
    const messageDescriptor = Object.getOwnPropertyDescriptor(cause, "message");
    const nameDescriptor = Object.getOwnPropertyDescriptor(cause, "name");
    const message =
      messageDescriptor &&
      "value" in messageDescriptor &&
      typeof messageDescriptor.value === "string"
        ? messageDescriptor.value
        : "Classifier transport failed";
    const name =
      nameDescriptor &&
      "value" in nameDescriptor &&
      typeof nameDescriptor.value === "string"
        ? nameDescriptor.value
        : "Error";
    if (
      apiKey !== undefined &&
      apiKey.length > 0 &&
      (message.includes(apiKey) || name.includes(apiKey))
    ) {
      return new Error("Classifier transport cause redacted");
    }
    const causeDescriptor = Object.getOwnPropertyDescriptor(cause, "cause");
    const nested =
      causeDescriptor && "value" in causeDescriptor
        ? safeTransportCause(causeDescriptor.value, apiKey, seen)
        : undefined;
    const retained =
      nested === undefined
        ? new Error(message)
        : new Error(message, { cause: nested });
    retained.name = name;
    return retained;
  }
  if (typeof cause === "string") {
    return apiKey !== undefined && apiKey.length > 0 && cause.includes(apiKey)
      ? new Error("Classifier transport cause redacted")
      : cause;
  }
  if (
    cause === null ||
    typeof cause === "number" ||
    typeof cause === "boolean"
  ) {
    return cause;
  }
  return new Error("Classifier transport cause redacted");
}

function providerRequestFor(
  request: z.output<typeof classifierRequestEnvelopeSchema>,
  model: string,
): Record<string, unknown> {
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      const { kind, ...fields } = question;
      return [id, { type: kind, ...fields }];
    }),
  );
  return { model, state: request.state, questions };
}

function validateResponseText(text: string): string {
  const parsed = responseTextSchema.safeParse(text);
  if (!parsed.success) {
    throw new ClassifierFailure("response", "Classifier response is too large");
  }
  return parsed.data;
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return validateResponseText(await response.text());
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > CLASSIFIER_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ClassifierFailure(
          "response",
          "Classifier response is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return validateResponseText(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch (cause) {
    throw new ClassifierFailure(
      "response",
      "Classifier response is not valid UTF-8",
      { cause },
    );
  }
}

function parseResponseJson(text: string): unknown {
  const parsed = responseJsonSchema.safeParse(text);
  if (parsed.success) {
    return parseBoundedJsonDocument(parsed.data, "response", "response").value;
  }
  throw new ClassifierFailure(
    "response",
    "Classifier response is not valid JSON",
  );
}

function prepareRequest(
  request: ClassifierRequestInput,
  model: string,
): {
  readonly request: ClassifierRequest;
  readonly requestData: JsonValue;
  readonly body: string;
} {
  const preflight = parseBoundedJson(request, "request", "request");
  const envelope = classifierRequestEnvelopeSchema.safeParse(preflight);
  if (!envelope.success) {
    throw new ClassifierFailure(
      "request",
      "Classifier request is malformed or exceeds the safe question limits",
    );
  }
  if (!classifierStateSizeSchema.safeParse(envelope.data.state).success) {
    throw new ClassifierFailure(
      "request",
      "Classifier state exceeds the 768 KiB limit",
    );
  }
  const serializedRequest = serializeBoundedJsonDocument(
    providerRequestFor(envelope.data, model),
    "request body",
    CLASSIFIER_MAX_BODY_BYTES,
  );
  try {
    return {
      request: classifierRequestSchema.parse(preflight),
      requestData: serializedRequest.value,
      body: serializedRequest.text,
    };
  } catch {
    throw new ClassifierFailure(
      "request",
      "Classifier request is malformed or exceeds the safe JSON limits",
    );
  }
}

export class SystemOneClient {
  constructor(
    private readonly connection?: PrivateClassifierConnection,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  async classify(
    input: ClassifierRequestInput,
    signal: AbortSignal,
    onObservation: ClassifierObservationSink,
  ): Promise<ClassifierResult> {
    signal.throwIfAborted();
    const preparedRequest = prepareRequest(
      input,
      requestModelFor(this.connection),
    );
    const parsedRequest = preparedRequest.request;
    const systemOneRequest =
      systemOneNoulRequestSchema.safeParse(parsedRequest);
    if (!systemOneRequest.success) {
      throw new ClassifierFailure(
        "unsupported-kind",
        "System One Choice and Score mapping is not implemented yet",
      );
    }
    const request = systemOneRequest.data;
    const connection = validateConnection(this.connection);
    const credential =
      connection.apiKey === undefined || connection.apiKey.length === 0
        ? undefined
        : connection.apiKey;
    const requestData = preparedRequest.requestData;
    const body = preparedRequest.body;
    const attempt = {
      observationId: randomUUID(),
      model: connection.model,
      request: requestData,
      startedAt: Date.now(),
    };
    const deadline = this.monotonicNow() + CLASSIFIER_TRANSPORT_BUDGET_MS;
    let timedOut = false;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, CLASSIFIER_TRANSPORT_BUDGET_MS);
    const abort = (): void => timeoutController.abort(signal.reason);
    const assertActive = (): void => {
      if (signal.aborted) signal.throwIfAborted();
      if (timedOut || this.monotonicNow() >= deadline) {
        throw new ClassifierFailure(
          "deadline",
          "Classifier request exceeded the 20-second transport budget",
        );
      }
    };
    let attemptFinalized = false;
    signal.addEventListener("abort", abort, { once: true });
    try {
      const headers = new Headers({ "content-type": "application/json" });
      if (credential !== undefined) {
        headers.set("authorization", `Bearer ${credential}`);
      }
      let response: Response;
      try {
        response = await this.fetchImplementation(connection.url, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: timeoutController.signal,
        });
      } catch (cause) {
        assertActive();
        throw new ClassifierFailure(
          "transport",
          "Classifier request could not be completed",
          { cause: safeTransportCause(cause, credential) },
        );
      }
      assertActive();
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        assertActive();
        throw new ClassifierFailure(
          "transport",
          `Classifier endpoint returned HTTP ${response.status}`,
        );
      }
      let responseText: string;
      try {
        responseText = await readResponseText(response);
      } catch (cause) {
        assertActive();
        if (cause instanceof ClassifierFailure) throw cause;
        throw new ClassifierFailure(
          "transport",
          "Classifier response could not be read",
          { cause: safeTransportCause(cause, credential) },
        );
      }
      assertActive();
      const rawResponse = parseResponseJson(responseText);
      assertActive();
      let mapped: ReturnType<typeof mapSystemOneResponse>;
      try {
        mapped = mapSystemOneResponse(rawResponse, request, credential);
      } catch (cause) {
        throw new ClassifierFailure(
          "response",
          "Classifier response does not match the declared questions",
          { cause },
        );
      }
      assertActive();
      const observation: SeqlaneObservation = {
        observationId: attempt.observationId,
        kind: "model",
        state: "succeeded",
        attemptIndex: 0,
        model: {
          operation: "classifier",
          provider: "typesafe",
          model: mapped.result.model,
          request: attempt.request,
          response: mapped.rawResponse,
          usage: mapped.rawUsage,
          startedAt: attempt.startedAt,
          endedAt: Date.now(),
        },
      };
      assertActive();
      attemptFinalized = true;
      onObservation(observation);
      assertActive();
      return mapped.result;
    } catch (cause) {
      emitFailedSystemOneObservation({
        finalized: attemptFinalized,
        ...attempt,
        cause,
        cancelled: signal.aborted,
        onObservation,
      });
      throw cause;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

export function createClassifierTaskRunner(
  connection: PrivateClassifierConnection,
): ClassifierTaskRunner {
  const client = new SystemOneClient(connection);
  return (request, signal, onObservation) =>
    client.classify(request, signal, onObservation);
}

export function createClassifierTaskRunnerOption(
  connection?: PrivateClassifierConnection,
): { readonly classifier?: ClassifierTaskRunner } {
  if (connection === undefined) return {};
  return { classifier: createClassifierTaskRunner(connection) };
}
