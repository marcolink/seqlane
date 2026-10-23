import type { ClassifierRequestInput, ClassifierResult } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import type { Effect } from "effect";
import { z } from "zod";

export type { PrivateClassifierConnection } from "./connection.js";

export type ClassifierObservationSink = (
  observation: SeqlaneObservation,
) => void;

export type ClassifierTaskRunner = (
  request: ClassifierRequestInput,
  signal: AbortSignal,
  onObservation: ClassifierObservationSink,
) => Effect.Effect<ClassifierResult, unknown>;

export const classifierFailureCodeSchema = z.enum([
  "configuration",
  "request",
  "transport",
  "response",
  "deadline",
]);

export type ClassifierFailureCode = z.infer<typeof classifierFailureCodeSchema>;

export class ClassifierFailure extends Error {
  constructor(
    readonly code: ClassifierFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClassifierFailure";
  }
}
