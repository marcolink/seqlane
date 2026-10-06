import { z } from "zod";
import { retainedFindingSchema } from "./review-v5-findings.js";
import {
  reviewCommitIdSchema,
  reviewDecimalIdSchema,
  reviewDigestSchema,
  reviewFindingIdPartsSchema,
  reviewGenerationSchema,
  reviewPositiveIntegerSchema,
  reviewSanitizedTextSchema,
  reviewUtf8StringSchema,
} from "./review-v5-primitives.js";
import {
  reviewManifestReferenceSchema,
  reviewManifestSummarySchema,
  reviewPublicationOperationSchema,
  reviewPublicationSourceSchema,
  reviewPublishedCostSchema,
  reviewRunStatusSchema,
} from "./review-v5-publication.js";

const checkpointCommon = {
  version: z.literal(1),
  generation: reviewGenerationSchema,
  baselineRevision: reviewCommitIdSchema,
  baseBranch: reviewUtf8StringSchema(512),
};
export const reviewScopeCheckpointSchema = z.discriminatedUnion("lastMode", [
  z.strictObject({ ...checkpointCommon, lastMode: z.literal("baseline") }),
  z.strictObject({
    ...checkpointCommon,
    lastMode: z.enum(["incremental", "no-change"]),
    fromRevision: reviewCommitIdSchema,
  }),
]);
export const reviewStateV5Schema = z
  .strictObject({
    schemaVersion: z.literal(5),
    stateRevision: reviewPositiveIntegerSchema,
    repositoryId: reviewDecimalIdSchema,
    pullRequestNumber: reviewPositiveIntegerSchema,
    baseRevision: reviewCommitIdSchema,
    reviewedRevision: reviewCommitIdSchema,
    previousReviewedRevision: reviewCommitIdSchema.optional(),
    nextFindingIndex: reviewPositiveIntegerSchema,
    findings: z.array(retainedFindingSchema).max(40),
    limitations: z.array(reviewSanitizedTextSchema).max(20),
    scopeCheckpoint: reviewScopeCheckpointSchema,
    runStatus: reviewRunStatusSchema,
    manifestReference: reviewManifestReferenceSchema,
    manifestSummary: reviewManifestSummarySchema,
    publicationOperation: reviewPublicationOperationSchema,
    consumedSources: z.array(reviewPublicationSourceSchema).min(1).max(40),
    publishedCost: reviewPublishedCostSchema,
  })
  .superRefine((state, ctx) => {
    const {
      scopeCheckpoint: checkpoint,
      manifestReference: reference,
      publicationOperation: operation,
    } = state;
    const ids = new Set<string>();
    let highestIndex = 0n;
    for (const [index, finding] of state.findings.entries()) {
      const parts = reviewFindingIdPartsSchema.parse(finding.id);
      const numericIdentity = `${parts.generation}:${parts.index}`;
      if (
        parts.pullRequestNumber !== String(state.pullRequestNumber) ||
        parts.generation !== checkpoint.generation ||
        parts.index === 0n ||
        ids.has(numericIdentity)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index, "id"],
          message: "Finding ID is duplicated or belongs to another generation",
        });
      }
      ids.add(numericIdentity);
      if (parts.index > highestIndex) highestIndex = parts.index;
      if (
        (finding.comparisonOutcome === "resolved" ||
          finding.status === "reopened") &&
        finding.comparisonOutcome !== "not_reviewed" &&
        finding.verification?.headRevision !== state.reviewedRevision
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index],
          message: "Lifecycle transition lacks current-head verification",
        });
      }
    }
    if (BigInt(state.nextFindingIndex) <= highestIndex)
      ctx.addIssue({
        code: "custom",
        message: "Next finding index would reuse an allocated identity",
      });
    if (
      checkpoint.lastMode === "baseline" &&
      (checkpoint.baselineRevision !== state.reviewedRevision ||
        state.previousReviewedRevision !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Baseline checkpoint must name its reviewed head without a predecessor",
      });
    }
    if (
      checkpoint.lastMode !== "baseline" &&
      state.previousReviewedRevision !== undefined &&
      checkpoint.fromRevision !== state.previousReviewedRevision
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Checkpoint predecessor differs from the comparable predecessor",
      });
    }
    if (
      state.runStatus.publication !== "published" ||
      state.runStatus.admission !== "admissible"
    )
      ctx.addIssue({
        code: "custom",
        message: "A v5 report must be completely published and admissible",
      });
    if (
      reference.repositoryId !== state.repositoryId ||
      reference.pullRequestNumber !== state.pullRequestNumber ||
      reference.reviewedRevision !== state.reviewedRevision ||
      operation.pullRequestNumber !== state.pullRequestNumber ||
      operation.stateRevision !== state.stateRevision ||
      reference.workflowRunId !== operation.source.sourceRunId ||
      reference.workflowAttempt !== operation.source.sourceAttempt ||
      reference.scopeIdentityDigest !== operation.source.scopeIdentityDigest
    )
      ctx.addIssue({
        code: "custom",
        message: "Manifest, operation, and state identities disagree",
      });
    const sources = state.consumedSources.map(
      (source) => `${source.sourceRunId}:${source.sourceAttempt}`,
    );
    if (
      new Set(sources).size !== sources.length ||
      !state.consumedSources.some(
        (source) =>
          source.sourceRunId === operation.source.sourceRunId &&
          source.sourceAttempt === operation.source.sourceAttempt &&
          source.scopeIdentityDigest === operation.source.scopeIdentityDigest,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Consumed sources must be unique and include the published source",
      });
    }
    const cost = state.publishedCost;
    if (
      cost.lastRun.runId !== operation.source.sourceRunId ||
      cost.lastRun.attempt !== operation.source.sourceAttempt ||
      cost.publishedRunCount < sources.length ||
      state.consumedSources.some(
        (source) =>
          BigInt(source.sourceRunId) > BigInt(cost.highWater.runId) ||
          (source.sourceRunId === cost.highWater.runId &&
            source.sourceAttempt > cost.highWater.attempt),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Published cost identities do not cover consumed sources",
      });
  });
export const reviewMetadataV5Schema = z.strictObject({
  schemaVersion: z.literal(5),
  repositoryId: reviewDecimalIdSchema,
  pullRequestNumber: reviewPositiveIntegerSchema,
  reviewedRevision: reviewCommitIdSchema,
  generation: reviewGenerationSchema,
  stateRevision: reviewPositiveIntegerSchema,
  run: z.strictObject({
    id: reviewDecimalIdSchema,
    attempt: reviewPositiveIntegerSchema,
  }),
  stateDigest: reviewDigestSchema,
});
export type ReviewStateV5 = z.infer<typeof reviewStateV5Schema>;
export type ReviewMetadataV5 = z.infer<typeof reviewMetadataV5Schema>;
export type ScopeCheckpoint = z.infer<typeof reviewScopeCheckpointSchema>;
