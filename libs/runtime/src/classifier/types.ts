import type { ClassifierRequestInput, ClassifierResult } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import type { Tracer } from "effect";
import { z } from "zod";

export type { PrivateClassifierConnection } from "./connection.js";

export type ClassifierObservationSink = (
  observation: SeqlaneObservation,
) => void;

export interface ClassifierExecutionTelemetry {
  readonly tracer: Tracer.Tracer;
  readonly parentSpan: Tracer.AnySpan;
}

export type ClassifierTaskRunner = (
  request: ClassifierRequestInput,
  signal: AbortSignal,
  onObservation: ClassifierObservationSink,
  telemetry?: ClassifierExecutionTelemetry,
) => Promise<ClassifierResult>;

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
