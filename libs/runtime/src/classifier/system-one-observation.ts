import type { JsonValue } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import { ClassifierFailure, type ClassifierObservationSink } from "./types.js";

export function emitFailedSystemOneObservation(options: {
  readonly finalized: boolean;
  readonly observationId: string;
  readonly model: string;
  readonly request: JsonValue;
  readonly startedAt: number;
  readonly cause: unknown;
  readonly cancelled: boolean;
  readonly onObservation: ClassifierObservationSink;
}): void {
  if (options.finalized) return;
  const error = options.cancelled
    ? "Classifier request was cancelled"
    : options.cause instanceof ClassifierFailure
      ? `${options.cause.code}: ${options.cause.message}`
      : "Classifier request failed";
  const observation: SeqlaneObservation = {
    observationId: options.observationId,
    kind: "model",
    state: options.cancelled ? "cancelled" : "failed",
    attemptIndex: 0,
    model: {
      operation: "classifier",
      provider: "typesafe",
      model: options.model,
      request: options.request,
      startedAt: options.startedAt,
      endedAt: Date.now(),
      error: error.slice(0, 2_000),
    },
  };
  options.onObservation(observation);
}
