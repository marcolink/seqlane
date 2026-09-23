import { randomUUID } from "node:crypto";
import type {
  ClassifierRequest,
  ClassifierRequestInput,
  ClassifierResult,
  JsonValue,
} from "@seqlane/core";
import {
  classifierRequestSchema,
  classifierResultSchema,
  jsonValueSchema,
  plainRecordSchema,
} from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import { z } from "zod";
import {
  parseBoundedJson,
  CLASSIFIER_MAX_BODY_BYTES,
  CLASSIFIER_MAX_STATE_BYTES,
  serializeBoundedJson,
} from "./payload-limits.js";
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

export const CLASSIFIER_TRANSPORT_BUDGET_MS = 20_000;

const knownResponseSchema = z.looseObject({
  model: z.string().min(1),
  answers: plainRecordSchema.pipe(z.record(z.string(), z.unknown())),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

const classifierRequestEnvelopeSchema = z
  .strictObject({
    state: z.unknown(),
    questions: plainRecordSchema,
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

const providerNoulAnswerSchema = z.looseObject({
  type: z.literal("noul"),
  noul: z.number().finite().min(0).max(1),
});

const extensionRecordSchema = plainRecordSchema.pipe(
  z.record(z.string(), jsonValueSchema),
);

function validateConnection(
  connection: PrivateClassifierConnection | undefined,
): ValidatedClassifierConnection {
  const parsed = privateClassifierConnectionSchema.safeParse(connection);
  if (!parsed.success) {
    throw new ClassifierFailure(
      "configuration",
      "Classifier connection must contain a safe URL, model, and required API key",
    );
  }
  return parsed.data;
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
  request: ClassifierRequest,
  model: string,
): Record<string, JsonValue> {
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      const { kind, ...fields } = question;
      return [id, { type: kind, ...fields }];
    }),
  );
  return { model, state: request.state, questions };
}

function extensionsFrom(
  value: Record<string, unknown>,
  knownFields: readonly string[],
): Record<string, JsonValue> | undefined {
  const known = new Set(knownFields);
  const extensions = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
  if (Object.keys(extensions).length === 0) return undefined;
  return extensionRecordSchema.parse(extensions);
}

function providerResponseSchemaFor(request: ClassifierRequest) {
  return knownResponseSchema.superRefine((response, context) => {
    const requestedIds = Object.keys(request.questions).sort();
    const responseIds = Object.keys(response.answers).sort();
    if (
      requestedIds.length !== responseIds.length ||
      requestedIds.some((id, index) => id !== responseIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["answers"],
        message: "Classifier answer IDs must match the request",
      });
      return;
    }
    for (const id of requestedIds) {
      if (!providerNoulAnswerSchema.safeParse(response.answers[id]).success) {
        context.addIssue({
          code: "custom",
          path: ["answers", id],
          message: "System One Noul answer is malformed",
        });
      }
    }
  });
}

function mapAnswer(raw: unknown): ClassifierResult["answers"][string] {
  const answer = providerNoulAnswerSchema.parse(raw);
  const extensions = extensionsFrom(answer, ["type", "noul"]);
  return {
    kind: "noul",
    probability: answer.noul,
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function mapResponse(
  raw: unknown,
  request: ClassifierRequest,
): ClassifierResult {
  const providerResponse = providerResponseSchemaFor(request).parse(raw);
  const answers = Object.fromEntries(
    Object.keys(request.questions).map((id) => [
      id,
      mapAnswer(providerResponse.answers[id]),
    ]),
  );
  const usageExtensions = extensionsFrom(providerResponse.usage, [
    "input_tokens",
    "output_tokens",
  ]);
  const responseExtensions = extensionsFrom(providerResponse, [
    "model",
    "answers",
    "usage",
  ]);
  const result = {
    model: providerResponse.model,
    answers,
    usage: {
      inputTokens: providerResponse.usage.input_tokens,
      outputTokens: providerResponse.usage.output_tokens,
      ...(usageExtensions === undefined ? {} : { extensions: usageExtensions }),
    },
    ...(responseExtensions === undefined
      ? {}
      : { extensions: responseExtensions }),
  };
  return classifierResultSchema.parse(result);
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
  if (!parsed.success) {
    throw new ClassifierFailure(
      "response",
      "Classifier response is not valid JSON",
    );
  }
  return parseBoundedJson(parsed.data, "response", "response");
}

function parseRequest(request: ClassifierRequestInput): ClassifierRequest {
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
  try {
    return classifierRequestSchema.parse(preflight);
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
  ) {}

  async classify(
    input: ClassifierRequestInput,
    signal: AbortSignal,
    onObservation: ClassifierObservationSink,
  ): Promise<ClassifierResult> {
    signal.throwIfAborted();
    const parsedRequest = parseRequest(input);
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
    const providerRequest = providerRequestFor(request, connection.model);
    const body = serializeBoundedJson(providerRequest, "request body");
    const requestData: JsonValue = providerRequest;
    if (
      connection.apiKey !== undefined &&
      connection.apiKey.length > 0 &&
      body.includes(connection.apiKey)
    ) {
      throw new ClassifierFailure(
        "request",
        "Classifier request contains authentication data",
      );
    }
    const requestStartedAt = Date.now();
    const deadline = performance.now() + CLASSIFIER_TRANSPORT_BUDGET_MS;
    let timedOut = false;
    const timeoutController = new AbortController();
    const remaining = Math.max(0, deadline - performance.now());
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, remaining);
    const abort = (): void => timeoutController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const headers = new Headers({ "content-type": "application/json" });
      if (connection.apiKey !== undefined) {
        headers.set("authorization", `Bearer ${connection.apiKey}`);
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
        if (signal.aborted) signal.throwIfAborted();
        if (timedOut || performance.now() >= deadline) {
          throw new ClassifierFailure(
            "deadline",
            "Classifier request exceeded the 20-second transport budget",
          );
        }
        throw new ClassifierFailure(
          "transport",
          "Classifier request could not be completed",
          { cause: safeTransportCause(cause, connection.apiKey) },
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ClassifierFailure(
          "transport",
          `Classifier endpoint returned HTTP ${response.status}`,
        );
      }
      const responseText = await readResponseText(response);
      signal.throwIfAborted();
      if (
        connection.apiKey !== undefined &&
        connection.apiKey.length > 0 &&
        responseText.includes(connection.apiKey)
      ) {
        throw new ClassifierFailure(
          "response",
          "Classifier response contains authentication data",
        );
      }
      const rawResponse = parseResponseJson(responseText);
      let result: ClassifierResult;
      try {
        result = mapResponse(rawResponse, request);
      } catch {
        throw new ClassifierFailure(
          "response",
          "Classifier response does not match the declared questions",
        );
      }
      if (timedOut || performance.now() >= deadline) {
        throw new ClassifierFailure(
          "deadline",
          "Classifier request exceeded the 20-second transport budget",
        );
      }
      signal.throwIfAborted();
      const rawModel = plainRecordSchema.parse(rawResponse);
      const rawUsage = plainRecordSchema
        .pipe(z.record(z.string(), z.unknown()))
        .parse(rawModel.usage);
      const rawResponseData = jsonValueSchema.parse(rawResponse);
      const observation: SeqlaneObservation = {
        observationId: randomUUID(),
        kind: "model",
        state: "succeeded",
        attemptIndex: 0,
        model: {
          operation: "classifier",
          provider: "typesafe",
          model: result.model,
          request: requestData,
          response: rawResponseData,
          usage: jsonValueSchema.parse(rawUsage),
          startedAt: requestStartedAt,
          endedAt: Date.now(),
        },
      };
      onObservation(observation);
      return result;
    } catch (cause) {
      if (signal.aborted) signal.throwIfAborted();
      if (cause instanceof ClassifierFailure) throw cause;
      if (timedOut || performance.now() >= deadline) {
        throw new ClassifierFailure(
          "deadline",
          "Classifier request exceeded the 20-second transport budget",
        );
      }
      throw new ClassifierFailure(
        "response",
        "Classifier response could not be validated",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

export function createClassifierTaskRunner(
  connection?: PrivateClassifierConnection,
): ClassifierTaskRunner {
  const client = new SystemOneClient(connection);
  return (request, signal, onObservation) =>
    client.classify(request, signal, onObservation);
}
