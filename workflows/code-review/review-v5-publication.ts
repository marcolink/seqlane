import { z } from "zod";
import {
  reviewCanonicalPathSchema,
  reviewCommitIdSchema,
  reviewDecimalIdSchema,
  reviewDigestSchema,
  reviewPositiveIntegerSchema,
  reviewUtf8StringSchema,
} from "./review-v5-primitives.js";

export const reviewRunStatusSchema = z
  .strictObject({
    coverage: z.enum(["pending", "complete", "incomplete"]),
    finding: z.enum(["pending", "valid", "invalid"]),
    publication: z.enum([
      "not-started",
      "in-progress",
      "published",
      "uncertain",
      "failed",
      "cancelled",
      "stale",
    ]),
    admission: z.enum(["blocked", "admissible"]),
  })
  .superRefine((status, ctx) => {
    const admissible =
      status.coverage === "complete" &&
      status.finding === "valid" &&
      status.publication === "published";
    if ((status.admission === "admissible") !== admissible)
      ctx.addIssue({
        code: "custom",
        message: "Admission contradicts execution and publication status",
      });
  });
export const reviewManifestReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestSchema: z.literal("review.run-manifest/v1"),
  repositoryId: reviewDecimalIdSchema,
  pullRequestNumber: reviewPositiveIntegerSchema,
  workflowId: reviewDecimalIdSchema,
  workflowPath: reviewCanonicalPathSchema,
  workflowDefinitionRevision: reviewCommitIdSchema,
  workflowRunId: reviewDecimalIdSchema,
  workflowAttempt: reviewPositiveIntegerSchema,
  manifestRunId: reviewUtf8StringSchema(128),
  reviewedRevision: reviewCommitIdSchema,
  scopeIdentityDigest: reviewDigestSchema,
  artifactId: reviewDecimalIdSchema,
  artifactName: reviewUtf8StringSchema(256),
  compressedBytes: reviewPositiveIntegerSchema.max(512 * 1024),
  uncompressedBytes: reviewPositiveIntegerSchema.max(2 * 1024 * 1024),
  digest: reviewDigestSchema,
  readback: z.literal("verified"),
});
export const reviewPublicationSourceSchema = z.strictObject({
  kind: z.literal("review"),
  sourceRunId: reviewDecimalIdSchema,
  sourceAttempt: reviewPositiveIntegerSchema,
  scopeIdentityDigest: reviewDigestSchema,
});
export const reviewPublicationOperationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  writerKind: z.literal("full-review"),
  pullRequestNumber: reviewPositiveIntegerSchema,
  stateRevision: reviewPositiveIntegerSchema,
  writerRunId: reviewDecimalIdSchema,
  writerAttempt: reviewPositiveIntegerSchema,
  source: reviewPublicationSourceSchema,
  payloadDigest: reviewDigestSchema,
});
export const reviewPublishedRunIdentitySchema = z.strictObject({
  runId: reviewDecimalIdSchema,
  attempt: reviewPositiveIntegerSchema,
});
const usdSchema = reviewUtf8StringSchema(128).regex(
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/,
);
export const reviewPublishedCostSchema = z
  .strictObject({
    periodStart: z.iso.datetime(),
    knownUsd: usdSchema,
    publishedRunCount: reviewPositiveIntegerSchema,
    completeness: z.enum(["complete", "incomplete"]),
    lastRun: reviewPublishedRunIdentitySchema,
    lastRunKnownUsd: usdSchema.nullable(),
    highWater: reviewPublishedRunIdentitySchema,
  })
  .superRefine((cost, ctx) => {
    if (cost.lastRunKnownUsd === null && cost.completeness === "complete")
      ctx.addIssue({
        code: "custom",
        message: "Missing cost must remain incomplete",
      });
    if (
      BigInt(cost.highWater.runId) < BigInt(cost.lastRun.runId) ||
      (cost.highWater.runId === cost.lastRun.runId &&
        cost.highWater.attempt < cost.lastRun.attempt)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Cost high-water identity precedes its latest publication",
      });
    }
  });
export const reviewManifestSummarySchema = z
  .strictObject({
    itemCount: z.number().int().nonnegative().max(2_048),
    selectedPathCount: z.number().int().nonnegative().max(200),
    expectedLaneCount: z.number().int().nonnegative().max(2_048),
    completedLaneCount: z.number().int().nonnegative().max(2_048),
  })
  .superRefine((summary, ctx) => {
    if (summary.completedLaneCount !== summary.expectedLaneCount)
      ctx.addIssue({
        code: "custom",
        message: "Published manifest must have complete lane coverage",
      });
  });
export type RunStatus = z.infer<typeof reviewRunStatusSchema>;
export type ManifestReference = z.infer<typeof reviewManifestReferenceSchema>;
export type PublicationOperation = z.infer<
  typeof reviewPublicationOperationSchema
>;
