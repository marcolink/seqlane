import { Cause, Clock, Effect, Option, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { ClassifierRequest, JsonValue } from "@seqlane/core";
import { jsonValueSchema, plainRecordSchema } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import { z } from "zod";
import {
  parseBoundedJsonDocument,
  CLASSIFIER_MAX_BODY_BYTES,
} from "./payload-limits.js";
import { mapSystemOneResponse } from "./system-one-response.js";
import { ClassifierFailure, type ClassifierObservationSink } from "./types.js";
import type { ValidatedClassifierConnection } from "./connection.js";
import { emitFailedSystemOneObservation } from "./system-one-observation.js";
import {
  isRetryableHttpStatus,
  RetryableSystemOneAttempt,
} from "./system-one-retry.js";

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

export function safeTransportCause(
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

function validateResponseText(text: string): string {
  const parsed = responseTextSchema.safeParse(text);
  if (!parsed.success) {
    throw new ClassifierFailure("response", "Classifier response is too large");
  }
  return parsed.data;
}

function parseResponseJson(text: string): unknown {
  const parsed = responseJsonSchema.safeParse(text);
  if (parsed.success) return parsed.data;
  throw new ClassifierFailure(
    "response",
    "Classifier response is not valid JSON",
  );
}

interface SystemOneAttemptOptions {
  readonly attemptIndex: number;
  readonly observationId: string;
  readonly connection: ValidatedClassifierConnection;
  readonly credential?: string;
  readonly request: ClassifierRequest;
  readonly requestData: JsonValue;
  readonly body: string;
  readonly callerSignal: AbortSignal;
  readonly onObservation: ClassifierObservationSink;
}

interface AttemptState {
  startedAt?: number;
  response?: JsonValue;
  usage?: JsonValue;
  finalized: boolean;
}

interface ResponseBytes {
  readonly chunks: Uint8Array[];
  bytes: number;
}

function readResponseBytes(
  response: import("effect/http/HttpClientResponse").HttpClientResponse,
) {
  return Stream.runFoldEffect(
    response.stream,
    (): ResponseBytes => ({ chunks: [], bytes: 0 }),
    (state, chunk) => {
      const bytes = state.bytes + chunk.byteLength;
      if (bytes > CLASSIFIER_MAX_BODY_BYTES) {
        return Effect.fail(
          new ClassifierFailure("response", "Classifier response is too large"),
        );
      }
      state.chunks.push(chunk);
      state.bytes = bytes;
      return Effect.succeed(state);
    },
  ).pipe(
    Effect.flatMap(({ chunks, bytes }) =>
      Effect.try({
        try: () => {
          const body = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return validateResponseText(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
        },
        catch: (cause) =>
          cause instanceof ClassifierFailure
            ? cause
            : new ClassifierFailure(
                "response",
                "Classifier response is not valid UTF-8",
                { cause },
              ),
      }),
    ),
  );
}

function parsedResponseFor(
  text: string,
  credential?: string,
): { readonly value: JsonValue; readonly hasExactString: boolean } {
  const raw = parseResponseJson(text);
  const bounded = parseBoundedJsonDocument(
    raw,
    "response",
    "response",
    credential,
  );
  return {
    value: jsonValueSchema.parse(bounded.value),
    hasExactString: bounded.hasExactString,
  };
}

export function executeSystemOneAttempt(options: SystemOneAttemptOptions) {
  const state: AttemptState = { startedAt: 0, finalized: false };
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.credential !== undefined)
    headers.authorization = `Bearer ${options.credential}`;
  const request = HttpClientRequest.post(options.connection.url, {
    headers,
  }).pipe(HttpClientRequest.bodyText(options.body, "application/json"));

  const operation = Effect.scoped(
    Effect.gen(function* () {
      state.startedAt = yield* Clock.currentTimeMillis;
      const response = yield* Effect.flatMap(HttpClient.HttpClient, (client) =>
        HttpClient.withScope(client).execute(request),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new RetryableSystemOneAttempt(
              new ClassifierFailure(
                "transport",
                "Classifier request could not be completed",
                {
                  cause: safeTransportCause(cause, options.credential),
                },
              ),
            ),
        ),
      );
      const retryAfter = response.headers["retry-after"];
      if (response.status < 200 || response.status >= 300) {
        const failure = new ClassifierFailure(
          "transport",
          `Classifier endpoint returned HTTP ${response.status}`,
        );
        if (isRetryableHttpStatus(response.status)) {
          return yield* Effect.fail(
            new RetryableSystemOneAttempt(failure, retryAfter),
          );
        }
        return yield* Effect.fail(failure);
      }
      const responseText = yield* readResponseBytes(response).pipe(
        Effect.mapError((cause) => {
          if (cause instanceof ClassifierFailure) return cause;
          if (
            cause instanceof HttpClientError.HttpClientError &&
            cause.reason._tag === "EmptyBodyError"
          ) {
            return new ClassifierFailure(
              "response",
              "Classifier response is not valid JSON",
              { cause },
            );
          }
          return new RetryableSystemOneAttempt(
            new ClassifierFailure(
              "transport",
              "Classifier response could not be read",
              { cause: safeTransportCause(cause, options.credential) },
            ),
          );
        }),
      );
      const parsedResponse = yield* Effect.try({
        try: () => parsedResponseFor(responseText, options.credential),
        catch: (cause) =>
          cause instanceof ClassifierFailure
            ? cause
            : new ClassifierFailure(
                "response",
                "Classifier response is malformed",
                { cause },
              ),
      });
      const rawResponse = parsedResponse.value;
      if (!parsedResponse.hasExactString) {
        state.response = rawResponse;
        const rawRecord = plainRecordSchema.safeParse(rawResponse);
        if (rawRecord.success) {
          const rawUsage = rawRecord.data.usage;
          const parsedUsage = jsonValueSchema.safeParse(rawUsage);
          if (parsedUsage.success) state.usage = parsedUsage.data;
        }
      }
      let mapped: ReturnType<typeof mapSystemOneResponse>;
      try {
        mapped = mapSystemOneResponse(
          rawResponse,
          options.request,
          options.credential,
        );
      } catch (cause) {
        return yield* Effect.fail(
          new ClassifierFailure(
            "response",
            "Classifier response does not match the declared questions",
            { cause },
          ),
        );
      }
      const endedAt = yield* Clock.currentTimeMillis;
      const observation: SeqlaneObservation = {
        observationId: options.observationId,
        kind: "model",
        state: "succeeded",
        attemptIndex: options.attemptIndex,
        model: {
          operation: "classifier",
          provider: "typesafe",
          model: mapped.result.model,
          request: options.requestData,
          response: mapped.rawResponse,
          usage: mapped.rawUsage,
          startedAt: state.startedAt,
          endedAt,
        },
      };
      state.finalized = true;
      options.onObservation(observation);
      return mapped.result;
    }),
  );

  return operation.pipe(
    Effect.onExit((exit) =>
      Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
        Effect.sync(() => {
          if (state.finalized) return;
          state.finalized = true;
          const failure =
            exit._tag === "Failure"
              ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
              : undefined;
          const cause =
            failure instanceof RetryableSystemOneAttempt
              ? failure.failure
              : failure;
          emitFailedSystemOneObservation({
            observationId: options.observationId,
            attemptIndex: options.attemptIndex,
            model: options.connection.model,
            request: options.requestData,
            startedAt: state.startedAt ?? 0,
            endedAt,
            cause,
            cancelled: options.callerSignal.aborted,
            ...(state.response === undefined
              ? {}
              : { response: state.response }),
            ...(state.usage === undefined ? {} : { usage: state.usage }),
            onObservation: options.onObservation,
          });
        }),
      ),
    ),
  );
}
