import { z } from "zod";
import { gitRevisionSchema } from "./contracts.js";
import { reviewCanonicalPathSchema } from "@seqlane/code-review-workflow/contracts";

export const REVIEW_GIT_LIMITS = Object.freeze({
  admissionWallMs: 120_000,
  commandWallMs: 30_000,
  totalWallMs: 90_000,
  outputBytes: 2_048_000,
  eligiblePaths: 200,
  hunks: 1_000,
  batches: 8,
  batchBytes: 512_000,
  evidenceBytes: 2_048_000,
});

export const reviewScopePathSchema = reviewCanonicalPathSchema;

const commonIdentity = {
  pullRequestNumber: z.number().int().positive(),
  targetBranch: z.string().min(1).max(512),
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
};

export const reviewScopeIdentitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...commonIdentity, mode: z.literal("new-baseline") }),
  z.strictObject({
    ...commonIdentity,
    mode: z.literal("legacy-replacement"),
    reportId: z.string().regex(/^[1-9]\d{0,127}$/),
    legacyMarker: z.strictObject({
      schemaVersion: z.number().int().positive().max(4),
      markerDigest: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
  z.strictObject({
    ...commonIdentity,
    mode: z.enum(["incremental", "no-change"]),
    checkpointRevision: gitRevisionSchema,
    reportId: z.string().regex(/^[1-9]\d{0,127}$/),
  }),
]);
export type ReviewScopeIdentity = z.infer<typeof reviewScopeIdentitySchema>;

export const reviewScopePathListSchema = z.array(reviewScopePathSchema);
export const reviewScopeSelectionSchema = z.strictObject({
  scopeIdentity: reviewScopeIdentitySchema,
  eligiblePaths: reviewScopePathListSchema.max(REVIEW_GIT_LIMITS.eligiblePaths),
  excludedPaths: reviewScopePathListSchema.max(REVIEW_GIT_LIMITS.eligiblePaths),
  reviewablePaths: reviewScopePathListSchema.max(
    REVIEW_GIT_LIMITS.eligiblePaths,
  ),
});
export type ReviewScopeSelection = z.infer<typeof reviewScopeSelectionSchema>;

export const reviewTreeChangeSchema = z.strictObject({
  path: reviewScopePathSchema,
  evidenceForm: z.enum(["pr-patch", "change-evidence"]),
  oldMode: z.string().regex(/^[0-7]{6}$/),
  newMode: z.string().regex(/^[0-7]{6}$/),
  oldObjectId: gitRevisionSchema,
  newObjectId: gitRevisionSchema,
  status: z.enum(["A", "D", "M", "T"]),
});
export type ReviewTreeChange = z.infer<typeof reviewTreeChangeSchema>;

export const reviewPathPatchSchema = z.strictObject({
  patch: z.string(),
  hunkCount: z.number().int().nonnegative().max(REVIEW_GIT_LIMITS.hunks),
  treeChange: reviewTreeChangeSchema,
});
export type ReviewPathPatch = z.infer<typeof reviewPathPatchSchema>;

export const reviewEvidenceBatchSchema = z
  .strictObject({
    scopeIdentity: reviewScopeIdentitySchema,
    ordinal: z.number().int().positive().max(REVIEW_GIT_LIMITS.batches),
    status: z.literal("complete"),
    paths: reviewScopePathListSchema
      .min(1)
      .max(REVIEW_GIT_LIMITS.eligiblePaths),
    patch: z.string(),
    hunkCount: z.number().int().nonnegative().max(REVIEW_GIT_LIMITS.hunks),
    patchBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REVIEW_GIT_LIMITS.batchBytes),
  })
  .superRefine((batch, ctx) => {
    if (
      batch.patchBytes !== Buffer.byteLength(batch.patch) ||
      new Set(batch.paths).size !== batch.paths.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Evidence batch accounting is inconsistent",
      });
    }
  });
export type ReviewEvidenceBatch = z.infer<typeof reviewEvidenceBatchSchema>;

export const reviewScopeEvidenceSchema = reviewScopeSelectionSchema
  .extend({
    batches: z.array(reviewEvidenceBatchSchema).max(REVIEW_GIT_LIMITS.batches),
    // Local cause-admission evidence. Never part of discovery lane input.
    validationBatches: z
      .array(reviewEvidenceBatchSchema)
      .max(REVIEW_GIT_LIMITS.batches),
    evidenceBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REVIEW_GIT_LIMITS.evidenceBytes),
    treeChanges: z
      .array(reviewTreeChangeSchema)
      .max(REVIEW_GIT_LIMITS.eligiblePaths * 2),
    hunkCount: z.number().int().nonnegative().max(REVIEW_GIT_LIMITS.hunks),
  })
  .superRefine((evidence, ctx) => {
    const allBatches = [...evidence.batches, ...evidence.validationBatches];
    const eligible = new Set(evidence.eligiblePaths);
    const excluded = new Set(evidence.excludedPaths);
    const reviewable = new Set(evidence.reviewablePaths);
    const treeKeys = evidence.treeChanges.map((entry) =>
      JSON.stringify([entry.path, entry.evidenceForm]),
    );
    const forms =
      "checkpointRevision" in evidence.scopeIdentity
        ? ["pr-patch", "change-evidence"]
        : ["pr-patch"];
    const expectedTreeKeys = evidence.reviewablePaths.flatMap((path) =>
      forms.map((form) => JSON.stringify([path, form])),
    );
    if (
      treeKeys.length !== expectedTreeKeys.length ||
      new Set(treeKeys).size !== treeKeys.length ||
      expectedTreeKeys.some((key) => !treeKeys.includes(key))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Tree evidence does not match selected scope",
      });
    }
    if (
      eligible.size !== evidence.eligiblePaths.length ||
      excluded.size !== evidence.excludedPaths.length ||
      reviewable.size !== evidence.reviewablePaths.length ||
      [...excluded].some(
        (path) => !eligible.has(path) || reviewable.has(path),
      ) ||
      [...reviewable].some((path) => !eligible.has(path)) ||
      excluded.size + reviewable.size !== eligible.size ||
      allBatches.length > REVIEW_GIT_LIMITS.batches ||
      evidence.evidenceBytes !==
        allBatches.reduce((sum, batch) => sum + batch.patchBytes, 0) ||
      evidence.hunkCount !==
        allBatches.reduce((sum, batch) => sum + batch.hunkCount, 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Scope evidence accounting is inconsistent",
      });
    }
    const expectedValidationPaths =
      "checkpointRevision" in evidence.scopeIdentity
        ? reviewable
        : new Set<string>();
    for (const [batches, expected] of [
      [evidence.batches, reviewable],
      [evidence.validationBatches, expectedValidationPaths],
    ] as const) {
      const paths = batches.flatMap((batch) => batch.paths);
      if (
        paths.length !== expected.size ||
        new Set(paths).size !== paths.length ||
        paths.some((path) => !expected.has(path)) ||
        batches.some(
          (batch, index) =>
            batch.ordinal !== index + 1 ||
            JSON.stringify(batch.scopeIdentity) !==
              JSON.stringify(evidence.scopeIdentity),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Batch coverage does not match selected scope",
        });
      }
    }
  });
export type ReviewScopeEvidence = z.infer<typeof reviewScopeEvidenceSchema>;
