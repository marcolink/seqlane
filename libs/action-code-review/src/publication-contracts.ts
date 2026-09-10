import { z } from "zod";
import type { ReviewPublication } from "./contracts.js";
import {
  reviewMetricEventSchema,
  reviewRunSkillUsageSchema,
  reviewRunMetricsSchema,
  type ReviewMetricEvent,
  type ReviewRunMetrics,
} from "./metrics.js";

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
              skills: reviewRunSkillUsageSchema.optional(),
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
  readonly events: readonly ReviewMetricEvent[];
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

/** The frozen data accepted by the model-free publication workflow. */
export const publicationSnapshotSchema = z.strictObject({
  report: reportSchema,
  events: z.array(reviewMetricEventSchema).max(10_000),
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
export type PublicationEvent = ReviewMetricEvent;
