import type { JsonValue, SeqlaneEvent } from "@seqlane/core";
import { z } from "zod";
import type { ReviewPublication } from "./contracts.js";
import { reviewRunMetricsSchema, type ReviewRunMetrics } from "./metrics.js";

export const reviewFindingSchema = z.strictObject({
  id: z.string().min(1).max(128),
  severity: z.enum(["critical", "required", "optional", "nit"]),
  effectiveSeverity: z.enum(["critical", "required", "optional", "nit"]),
  disposition: z.enum([
    "open",
    "fixed",
    "wont-fix",
    "downgraded",
    "not-reproducible",
  ]),
  status: z.enum([
    "new",
    "open",
    "addressed",
    "resolved",
    "reopened",
    "dismissed",
  ]),
  axis: z.string().min(1).max(64),
  summary: z.string().min(1).max(2_000),
  recommendation: z.string().min(1).max(2_000),
  file: z.string().max(512).optional(),
  line: z.number().int().positive().optional(),
  aliases: z.array(z.string().min(1).max(128)).max(8),
  dispositionReason: z.string().max(2_000).optional(),
  dispositionBy: z.string().min(1).max(256).optional(),
  dispositionAt: z.string().min(1).max(64).optional(),
  dispositionCommentId: z.string().min(1).max(128).optional(),
  dispositionCommit: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .optional(),
  evidenceHeadRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .optional(),
});

export const ratingSchema = z.strictObject({
  axis: z.enum([
    "correctness",
    "readability",
    "architecture",
    "security",
    "performance",
  ]),
  rating: z.number().int().min(1).max(5),
  rationale: z.string().min(1).max(2_000),
});

export const reportSchema = z.strictObject({
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  baseRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
  overallRating: z.number().int().min(1).max(5),
  verdict: z.enum(["approve", "request-changes"]),
  summary: z.string().min(1).max(6_000),
  ratings: z.array(ratingSchema).length(5),
  findings: z.array(reviewFindingSchema).max(40),
  verification: z.array(z.string().max(1_000)).max(20),
  headRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
  pullRequestNumber: z.number().int().positive(),
  previousReviewedRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .optional(),
  nextFindingIndex: z.number().int().positive(),
  limitations: z.array(z.string().max(1_000)).max(20),
  stateTruncated: z.boolean(),
  runMetricsLedger: z.strictObject({
    schemaVersion: z.literal(1),
    runs: z
      .array(
        z.strictObject({
          githubRunId: z.string().regex(/^\d+$/).max(128),
          attempt: z.number().int().positive(),
          completedAt: z.string().min(1).max(64),
          reviewedRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
          metrics: reviewRunMetricsSchema,
        }),
      )
      .max(40),
  }),
});

export const ledgerEntrySchema = z
  .strictObject({
    githubRunId: z.string().regex(/^\d+$/).max(128),
    attempt: z.number().int().positive(),
    completedAt: z.string().min(1).max(64),
    reviewedRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
    metrics: z
      .object({
        schemaVersion: z.literal(1),
        runId: z.string().min(1).max(128),
        outcome: z.enum(["succeeded", "failed", "cancelled"]),
        durationMs: z.number().nonnegative(),
        totalCost: z.number().nonnegative(),
        totalTokens: z.object({
          input: z.number().int().nonnegative(),
          output: z.number().int().nonnegative(),
          reasoning: z.number().int().nonnegative(),
          cacheRead: z.number().int().nonnegative(),
          cacheWrite: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        }),
        tasks: z
          .array(
            z.strictObject({
              invocationId: z.string().min(1).max(256),
              task: z.string().min(1).max(512),
              taskId: z.string().min(1).max(256).optional(),
              resultState: z.enum([
                "queued",
                "waiting",
                "active",
                "retrying",
                "succeeded",
                "failed",
                "skipped",
                "cancelled",
              ]),
              durationMs: z.number().nonnegative(),
              model: z.string().min(1).max(256).optional(),
              provider: z.string().min(1).max(256).optional(),
              tokens: z
                .strictObject({
                  input: z.number().int().nonnegative(),
                  output: z.number().int().nonnegative(),
                  reasoning: z.number().int().nonnegative(),
                  cacheRead: z.number().int().nonnegative(),
                  cacheWrite: z.number().int().nonnegative(),
                  total: z.number().int().nonnegative().optional(),
                })
                .optional(),
              cost: z.number().nonnegative().optional(),
            }),
          )
          .max(40),
      })
      .strict(),
  })
  .strict();

export const ledgerSchema = z
  .object({ schemaVersion: z.literal(1), runs: z.array(ledgerEntrySchema) })
  .strict();
export const EMPTY_LEDGER = {
  schemaVersion: 1 as const,
  runs: [] as z.infer<typeof ledgerEntrySchema>[],
};

export interface PublicationSnapshot {
  readonly report: z.infer<typeof reportSchema>;
  readonly events: readonly SeqlaneEvent[];
  readonly eventsTruncated?: boolean;
  readonly runId: string;
  readonly githubRunId?: string;
  readonly attempt?: number;
  readonly completedAt?: string;
}
export interface DerivedPublication {
  readonly metrics: ReviewRunMetrics;
  readonly publication: ReviewPublication;
}

const boundedIdSchema = z.string().min(1).max(256);
const boundedJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(8_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(boundedJsonValueSchema).max(200),
    z
      .record(z.string().max(128), boundedJsonValueSchema)
      .superRefine((value, context) => {
        if (Object.keys(value).length > 200)
          context.addIssue({
            code: "too_big",
            maximum: 200,
            origin: "object",
            inclusive: true,
          });
      }),
  ]),
);
const eventSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("task"), taskId: boundedIdSchema }),
  z.strictObject({
    type: z.literal("validator"),
    validatorId: boundedIdSchema,
  }),
  z.strictObject({
    type: z.literal("validation-gate"),
    planNodeId: boundedIdSchema,
  }),
]);
const eventSummarySchema = z.strictObject({
  kind: z.enum(["null", "boolean", "number", "string", "array", "object"]),
  size: z.number().nonnegative().optional(),
  fields: z.array(z.string().max(128)).max(200).optional(),
});
const eventDisplayValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("present"),
    value: boundedJsonValueSchema,
  }),
  z.strictObject({
    state: z.literal("redacted"),
    summary: eventSummarySchema.optional(),
  }),
  z.strictObject({
    state: z.literal("truncated"),
    summary: eventSummarySchema,
  }),
  z.strictObject({
    state: z.literal("omitted"),
    reason: z.enum(["policy", "unavailable"]),
  }),
]);
const eventMetricsSchema = z.strictObject({
  durationMs: z.number().nonnegative().optional(),
  model: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(256).optional(),
  modelSelection: z
    .strictObject({
      model: z.strictObject({
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(256),
      }),
      reasoning: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional(),
    })
    .optional(),
  cost: z.number().nonnegative().optional(),
  tokens: z
    .strictObject({
      total: z.number().int().nonnegative().optional(),
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      reasoning: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
    })
    .optional(),
});
const eventErrorSchema = z.strictObject({
  category: z.enum([
    "InputValidationError",
    "ExecutorError",
    "OutputValidationError",
    "ValidationError",
    "RuntimeError",
  ]),
  message: z.string().max(4_000),
  name: z.string().max(128).optional(),
  taskId: boundedIdSchema.optional(),
  nodeId: boundedIdSchema.optional(),
  sourceId: boundedIdSchema.optional(),
  maximumIterations: z.number().int().positive().optional(),
  issues: z
    .array(
      z.strictObject({
        code: z.string().max(256),
        message: z.string().max(4_000),
        path: z.string().max(2_000).optional(),
      }),
    )
    .max(200)
    .optional(),
  evidence: boundedJsonValueSchema.optional(),
});
const eventBase = { workId: boundedIdSchema, runId: boundedIdSchema };
export const publicationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type: z.literal("run.started") }),
  z.strictObject({
    ...eventBase,
    type: z.literal("run.succeeded"),
    output: boundedJsonValueSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("run.failed"),
    error: eventErrorSchema,
  }),
  z.strictObject({ ...eventBase, type: z.literal("run.cancelled") }),
  z.strictObject({
    ...eventBase,
    type: z.literal("run.heartbeat"),
    activeInvocationIds: z.array(boundedIdSchema).max(200),
    elapsedMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.created"),
    invocationId: boundedIdSchema,
    planNodeId: boundedIdSchema,
    subject: eventSubjectSchema,
    taskId: boundedIdSchema.optional(),
    kind: z.enum(["workflow", "loop", "task", "validation"]),
    label: z.string().min(1).max(512),
    parentInvocationId: boundedIdSchema.optional(),
    iteration: z.number().int().nonnegative().optional(),
    siblingOrder: z.number().int().nonnegative(),
    dependencyIds: z.array(boundedIdSchema).max(200),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.progress"),
    invocationId: boundedIdSchema,
    state: z.enum(["active", "waiting"]),
    phase: z.string().min(1).max(256),
    message: z.string().max(4_000).optional(),
    label: z.string().max(512).optional(),
    waitingReason: z.string().max(256).optional(),
    workspace: z.enum(["shared", "exclusive"]).optional(),
    blockingInvocationId: boundedIdSchema.optional(),
    dependencyIds: z.array(boundedIdSchema).max(200).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.output"),
    invocationId: boundedIdSchema,
    policy: z.enum(["transient", "persistent"]),
    channel: z.enum(["task", "run"]),
    content: z.string().max(8_000),
    metrics: eventMetricsSchema.optional(),
    summary: eventSummarySchema.optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.input"),
    invocationId: boundedIdSchema,
    input: eventDisplayValueSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.result"),
    invocationId: boundedIdSchema,
    result: eventDisplayValueSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.activity"),
    invocationId: boundedIdSchema,
    activityId: boundedIdSchema,
    kind: z.enum(["tool", "skill"]),
    name: z.string().min(1).max(512),
    state: z.enum(["started", "progress", "succeeded", "failed"]),
    input: eventDisplayValueSchema.optional(),
    output: eventDisplayValueSchema.optional(),
    activityMetadata: eventDisplayValueSchema.optional(),
    startedAt: z.number().nonnegative().optional(),
    endedAt: z.number().nonnegative().optional(),
    message: z.string().max(4_000).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.started"),
    invocationId: boundedIdSchema,
    subject: eventSubjectSchema,
    taskId: boundedIdSchema.optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.succeeded"),
    invocationId: boundedIdSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.failed"),
    invocationId: boundedIdSchema,
    error: eventErrorSchema,
    disposition: z.enum([
      "retry_scheduled",
      "fail_run",
      "continue_siblings",
      "skip_dependents",
      "cancelled_by_policy",
    ]),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.skipped"),
    invocationId: boundedIdSchema,
    reason: z.string().max(4_000),
    dependencyIds: z.array(boundedIdSchema).max(200).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.cancelled"),
    invocationId: boundedIdSchema,
    reason: z.string().max(4_000).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.retrying"),
    invocationId: boundedIdSchema,
    attempt: z.number().int().positive(),
    maximumAttempts: z.number().int().positive().optional(),
    delayMs: z.number().nonnegative().optional(),
    nextAttemptAt: z.string().max(64).optional(),
    lastError: eventErrorSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
]) as z.ZodType<SeqlaneEvent>;

/** The frozen data accepted by the model-free publication workflow. */
export const publicationSnapshotSchema = z.strictObject({
  report: reportSchema,
  events: z.array(publicationEventSchema).max(10_000),
  eventsTruncated: z.boolean().default(false),
  runId: z.string().min(1).max(128),
  githubRunId: z.string().regex(/^\d+$/).max(128).optional(),
  attempt: z.number().int().positive().optional(),
  completedAt: z.string().min(1).max(64).optional(),
});
export type PublicationSnapshotInput = z.infer<
  typeof publicationSnapshotSchema
>;

export type PublicationReport = z.infer<typeof reportSchema>;
export type PublicationLedger = z.infer<typeof ledgerSchema>;
export type PublicationEvent = SeqlaneEvent;
