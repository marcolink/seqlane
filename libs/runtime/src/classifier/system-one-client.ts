import { randomUUID } from "node:crypto";
import { Clock, Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type {
  ClassifierRequest,
  ClassifierRequestInput,
  ClassifierResult,
  JsonValue,
} from "@seqlane/core";
import { classifierRequestSchema, plainRecordSchema } from "@seqlane/core";
import { z } from "zod";
import {
  parseBoundedJson,
  CLASSIFIER_MAX_BODY_BYTES,
  CLASSIFIER_MAX_STATE_BYTES,
  serializeBoundedJson,
  serializeBoundedJsonDocument,
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
import { runSystemOneOperation } from "./system-one-operation.js";
import { RetryableSystemOneAttempt } from "./system-one-retry.js";
import {
  executeSystemOneAttempt,
  safeTransportCause,
} from "./system-one-http-attempt.js";

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

class ObservationSinkFailure extends Error {
  constructor(readonly original: unknown) {
    super("Classifier observation sink failed");
  }
}

export class SystemOneClient {
  private readonly httpLayer: Layer.Layer<HttpClient.HttpClient>;

  constructor(
    private readonly connection?: PrivateClassifierConnection,
    fetchImplementation: typeof fetch = fetch,
    private readonly testClock?: Clock.Clock,
  ) {
    const httpLayer = Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.Fetch, fetchImplementation),
      Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" }),
    );
    this.httpLayer = httpLayer;
  }

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
    const request = preparedRequest.request;
    const connection = validateConnection(this.connection);
    const credential =
      connection.apiKey === undefined || connection.apiKey.length === 0
        ? undefined
        : connection.apiKey;
    const observationId = randomUUID();
    let sinkFailed = false;
    let sinkFailure: unknown;
    const observationSink: ClassifierObservationSink = (observation) => {
      try {
        onObservation(observation);
      } catch (cause) {
        sinkFailed = true;
        sinkFailure = cause;
        throw new ObservationSinkFailure(cause);
      }
    };

    const program = runSystemOneOperation({
      budgetMs: CLASSIFIER_TRANSPORT_BUDGET_MS,
      maxAttempts: 4,
      attempt: (attemptIndex) =>
        executeSystemOneAttempt({
          attemptIndex,
          observationId,
          connection,
          credential,
          request,
          requestData: preparedRequest.requestData,
          body: preparedRequest.body,
          callerSignal: signal,
          onObservation: observationSink,
        }),
    });

    try {
      const httpProvided = Effect.provide(program, this.httpLayer);
      const provided =
        this.testClock === undefined
          ? httpProvided
          : Effect.provideService(httpProvided, Clock.Clock, this.testClock);
      return await Effect.runPromise(provided, { signal });
    } catch (cause) {
      if (sinkFailed) throw sinkFailure;
      if (cause instanceof ObservationSinkFailure) throw cause.original;
      if (signal.aborted) signal.throwIfAborted();
      if (
        cause instanceof ClassifierFailure ||
        cause instanceof RetryableSystemOneAttempt
      ) {
        throw cause instanceof RetryableSystemOneAttempt
          ? cause.failure
          : cause;
      }
      throw new ClassifierFailure(
        "transport",
        "Classifier request could not be completed",
        { cause: safeTransportCause(cause, credential) },
      );
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
