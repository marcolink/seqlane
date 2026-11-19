import type { JsonValue } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import { ClassifierFailure, type ClassifierObservationSink } from "./types.js";

export function emitFailedSystemOneObservation(options: {
  readonly observationId: string;
  readonly attemptIndex: number;
  readonly model: string;
  readonly request: JsonValue;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly cause: unknown;
  readonly cancelled: boolean;
  readonly response?: JsonValue;
  readonly usage?: JsonValue;
  readonly onObservation: ClassifierObservationSink;
}): void {
  const error = options.cancelled
    ? "Classifier request was cancelled"
    : options.cause instanceof ClassifierFailure
      ? `${options.cause.code}: ${options.cause.message}`
      : "Classifier request failed";
  const observation: SeqlaneObservation = {
    observationId: options.observationId,
    kind: "model",
    state: options.cancelled ? "cancelled" : "failed",
    attemptIndex: options.attemptIndex,
    model: {
      operation: "classifier",
      provider: "typesafe",
      model: options.model,
      request: options.request,
      ...(options.response === undefined ? {} : { response: options.response }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      startedAt: options.startedAt,
      endedAt: options.endedAt,
      error: error.slice(0, 2_000),
    },
  };
  options.onObservation(observation);
}
