import { RuntimeError } from "@seqlane/core";
import type { RunRequest } from "@seqlane/protocol";
import {
  copyCommandErrorMetadata,
  runIdentitySchema,
  runCommandResultSchema,
  runTimingSchema,
  remoteErrorShapeSchema,
  runWorkflowIdentitySchema,
  type RunCancellationCode,
  type RunFailurePhase,
  type RunIdentity as RunIdentityContract,
  type RunWorkflowIdentity,
  type RunCommandResult,
} from "./cli-contracts.js";
import { errorMessage, serializeCommandError } from "./command.js";

export type RunIdentity = RunIdentityContract;

export function remoteError(error: unknown): Error {
  if (error instanceof Error) return error;
  let message: string | undefined;
  try {
    const remote = remoteErrorShapeSchema.safeParse(error);
    if (remote.success) message = remote.data.message;
  } catch {
    // Treat hostile remote values like any other unknown thrown value.
  }
  const normalized = new Error(message ?? errorMessage(error), {
    cause: error,
  });
  copyCommandErrorMetadata(normalized, error);
  return normalized;
}

export function runWorkflowIdentity(
  request: RunRequest,
  sourceReference?: string,
): RunWorkflowIdentity {
  return runWorkflowIdentitySchema.parse({
    id: request.workflow.id,
    reference: sourceReference ?? request.workflow.id,
  });
}

export function runTiming(startedAt: string, finishedAt: string): RunTiming {
  return runTimingSchema.parse({
    startedAt,
    finishedAt,
    durationMs: Math.max(
      0,
      new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    ),
  });
}

export type RunTiming = import("./cli-contracts.js").RunTiming;

export function createRunSuccessResult(
  request: RunRequest,
  sourceReference: string | undefined,
  identity: RunIdentity,
  output: unknown,
): RunCommandResult {
  const canonicalIdentity = runIdentitySchema.parse(identity);
  const finishedAt = new Date().toISOString();
  return runCommandResultSchema.parse({
    schemaVersion: 1,
    status: "succeeded",
    workflow: runWorkflowIdentity(request, sourceReference),
    ...canonicalIdentity,
    ...runTiming(canonicalIdentity.startedAt, finishedAt),
    output,
  });
}

export function createRunCancellationResult(
  request: RunRequest,
  sourceReference: string | undefined,
  identity: RunIdentity,
  code: RunCancellationCode,
  message: string,
): RunCommandResult {
  const canonicalIdentity = runIdentitySchema.parse(identity);
  const finishedAt = new Date().toISOString();
  return runCommandResultSchema.parse({
    schemaVersion: 1,
    status: "cancelled",
    workflow: runWorkflowIdentity(request, sourceReference),
    ...canonicalIdentity,
    ...runTiming(canonicalIdentity.startedAt, finishedAt),
    cancellation: { code, message },
  });
}

export function createRunFailureResult(
  error: unknown,
  phase: RunFailurePhase,
  request?: RunRequest,
  sourceReference?: string,
  identity?: RunIdentity,
): RunCommandResult {
  const finishedAt = new Date().toISOString();
  const canonicalIdentity =
    identity === undefined ? undefined : runIdentitySchema.parse(identity);
  return runCommandResultSchema.parse({
    schemaVersion: 1,
    status: "failed",
    phase,
    error: serializeCommandError(error),
    ...(request === undefined
      ? {}
      : { workflow: runWorkflowIdentity(request, sourceReference) }),
    ...(canonicalIdentity === undefined
      ? {}
      : {
          ...canonicalIdentity,
          ...runTiming(canonicalIdentity.startedAt, finishedAt),
        }),
  });
}

export function executionEventError(error: unknown): RuntimeError {
  return new RuntimeError(remoteError(error));
}
