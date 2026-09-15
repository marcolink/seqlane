import {
  seqlaneErrorMetadataSchema,
  seqlanePlanSnapshotSchema,
  serializedSeqlaneErrorSchema,
} from "@seqlane/protocol";
import { jsonValueSchema } from "@seqlane/core";
import { z } from "zod";

const workflowScopeSchema = z.enum(["repository", "user"]);

export const workflowListRecordSchema = z.strictObject({
  name: z.string(),
  scope: workflowScopeSchema,
  qualifiedName: z.string(),
  moduleSpecifier: z.string(),
  exportName: z.string(),
  description: z.string(),
});

export const workflowListResultSchema = z.array(workflowListRecordSchema);

const planWorkflowSchema = z.strictObject({
  name: z.string(),
  scope: z.enum(["repository", "user", "direct"]),
  qualifiedName: z.string(),
  moduleSpecifier: z.string(),
  exportName: z.string(),
  description: z.string().optional(),
});

export const planCommandResultSchema = z.strictObject({
  workflow: planWorkflowSchema,
  plan: seqlanePlanSnapshotSchema,
});

export type WorkflowListRecord = z.output<typeof workflowListRecordSchema>;
export type PlanCommandResult = z.output<typeof planCommandResultSchema>;

export const runWorkflowIdentitySchema = z.strictObject({
  id: z.string().min(1),
  reference: z.string().min(1),
});

export const remoteErrorShapeSchema = z.looseObject({
  message: z.string(),
});

const runResultMetricsSchema = z.strictObject({
  invocations: z.number().finite().nonnegative(),
  retries: z.number().finite().nonnegative(),
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  costUsd: z.number().finite().nonnegative().optional(),
});

export const runCommandErrorSchema = z.intersection(
  serializedSeqlaneErrorSchema,
  z.strictObject({
    code: z.string().min(1).optional(),
    suggestions: z.array(z.string().min(1)).readonly().optional(),
    ref: z.string().min(1).optional(),
  }),
);

export const runTimingSchema = z.strictObject({
  startedAt: z.iso.datetime({ precision: 3 }),
  finishedAt: z.iso.datetime({ precision: 3 }),
  durationMs: z.number().int().nonnegative(),
});

const optionalRunTimingSchema = runTimingSchema.partial();

export const runIdentitySchema = z.strictObject({
  workId: z.string().min(1),
  runId: z.string().min(1),
  startedAt: z.iso.datetime({ precision: 3 }),
});

export const runFailurePhaseSchema = z.enum([
  "command",
  "execution",
  "result-serialization",
]);

export const runCancellationCodeSchema = z.enum([
  "user_requested",
  "signal",
  "runtime_cancelled",
  "policy",
]);

/** Error fields copied across CLI error boundaries. */
export const commandErrorMetadataSchema = z.object({
  ...seqlaneErrorMetadataSchema.shape,
  validation: z.unknown().optional(),
  code: z.string().min(1).optional(),
  suggestions: z.array(z.string().min(1)).readonly().optional(),
  ref: z.string().min(1).optional(),
});

export type CommandErrorMetadata = z.output<typeof commandErrorMetadataSchema>;

export function parseCommandErrorMetadata(
  value: unknown,
): CommandErrorMetadata | undefined {
  try {
    const result = commandErrorMetadataSchema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    // Error handling must remain non-throwing for hostile getters and proxies.
    return undefined;
  }
}

export function copyCommandErrorMetadata(target: Error, source: unknown): void {
  const metadata = parseCommandErrorMetadata(source);
  if (metadata === undefined) return;
  for (const key of Object.keys(commandErrorMetadataSchema.shape) as Array<
    keyof CommandErrorMetadata
  >) {
    const value = metadata[key];
    if (value !== undefined) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
      });
    }
  }
}

export const runSuccessResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("succeeded"),
  workflow: runWorkflowIdentitySchema,
  workId: z.string().min(1),
  runId: z.string().min(1),
  ...runTimingSchema.shape,
  output: jsonValueSchema,
  metrics: runResultMetricsSchema.optional(),
});

export const runFailureResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("failed"),
  phase: runFailurePhaseSchema,
  error: runCommandErrorSchema,
  workflow: runWorkflowIdentitySchema.optional(),
  workId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  ...optionalRunTimingSchema.shape,
  metrics: runResultMetricsSchema.optional(),
});

export const runCancellationResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("cancelled"),
  workflow: runWorkflowIdentitySchema,
  workId: z.string().min(1),
  runId: z.string().min(1),
  ...runTimingSchema.shape,
  cancellation: z.strictObject({
    code: runCancellationCodeSchema,
    message: z.string(),
  }),
  metrics: runResultMetricsSchema.optional(),
});

export const runCommandResultSchema = z.discriminatedUnion("status", [
  runSuccessResultSchema,
  runFailureResultSchema,
  runCancellationResultSchema,
]);

export type RunWorkflowIdentity = z.output<typeof runWorkflowIdentitySchema>;
export type RunIdentity = z.output<typeof runIdentitySchema>;
export type RunFailurePhase = z.output<typeof runFailurePhaseSchema>;
export type RunCancellationCode = z.output<typeof runCancellationCodeSchema>;
export type RunTiming = z.output<typeof runTimingSchema>;
export type RunResultMetrics = z.output<typeof runResultMetricsSchema>;
export type RunCommandError = z.output<typeof runCommandErrorSchema>;
export type RunSuccessResult = z.output<typeof runSuccessResultSchema>;
export type RunFailureResult = z.output<typeof runFailureResultSchema>;
export type RunCancellationResult = z.output<
  typeof runCancellationResultSchema
>;
export type RunCommandResult = z.output<typeof runCommandResultSchema>;
