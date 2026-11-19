import { awaitAbort } from "../runtime/execution/await-abort.js";
import { randomUUID } from "node:crypto";
import { Cause, Effect, Layer } from "effect";
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

export class SystemOneClient {
  private readonly httpLayer: Layer.Layer<HttpClient.HttpClient>;

  constructor(
    private readonly connection?: PrivateClassifierConnection,
    fetchImplementation: typeof fetch = fetch,
  ) {
    const httpLayer = Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.Fetch, fetchImplementation),
      Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" }),
    );
    this.httpLayer = httpLayer;
  }

  classify(
    input: ClassifierRequestInput,
    signal: AbortSignal,
    onObservation: ClassifierObservationSink,
  ): Effect.Effect<ClassifierResult, unknown> {
    return Effect.suspend(() => {
      let sinkFailure: { readonly value: unknown } | undefined;
      let credential: string | undefined;
      const httpLayer = this.httpLayer;
      const connectionInput = this.connection;
      const operation = Effect.gen(function* () {
        signal.throwIfAborted();
        const preparedRequest = prepareRequest(
          input,
          requestModelFor(connectionInput),
        );
        const request = preparedRequest.request;
        const connection = validateConnection(connectionInput);
        credential =
          connection.apiKey === undefined || connection.apiKey.length === 0
            ? undefined
            : connection.apiKey;
        const observationId = randomUUID();
        const observationSink: ClassifierObservationSink = (observation) => {
          try {
            onObservation(observation);
          } catch (cause) {
            sinkFailure = { value: cause };
            throw cause;
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

        return yield* Effect.provide(program, httpLayer);
      });
      return operation.pipe(
        Effect.raceFirst(awaitAbort(signal, "Classifier cancelled")),
        Effect.catchCause((cause) => {
          const original = Cause.squash(cause);
          if (sinkFailure !== undefined) return Effect.fail(sinkFailure.value);
          if (signal.aborted) return Effect.fail(signal.reason);
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          if (
            original instanceof ClassifierFailure ||
            original instanceof RetryableSystemOneAttempt
          ) {
            return Effect.fail(
              original instanceof RetryableSystemOneAttempt
                ? original.failure
                : original,
            );
          }
          return Effect.fail(
            new ClassifierFailure(
              "transport",
              "Classifier request could not be completed",
              { cause: safeTransportCause(original, credential) },
            ),
          );
        }),
      );
    });
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
