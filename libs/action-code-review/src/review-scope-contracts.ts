import { z } from "zod";
import { gitRevisionSchema } from "./contracts.js";

export const REVIEW_GIT_LIMITS = Object.freeze({
  admissionWallMs: 120_000,
  commandWallMs: 30_000,
  totalWallMs: 90_000,
  totalCpuMs: 60_000,
  peakMemoryBytes: 256 * 1024 * 1024,
  outputBytes: 2_048_000,
  fetchBytes: 16 * 1024 * 1024,
  fetchWallMs: 30_000,
  eligiblePaths: 200,
  hunks: 1_000,
  batches: 8,
  batchBytes: 512_000,
  evidenceBytes: 2_048_000,
});

export const reviewScopePathSchema = z
  .string()
  .min(1)
  .superRefine((path, ctx) => {
    if (
      Buffer.byteLength(path, "utf8") > 512 ||
      Buffer.from(path, "utf8").toString("utf8") !== path ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:[/\\]/.test(path) ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid canonical Git path" });
    }
  });

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
  evidenceForm: z.enum(["review-patch", "change-evidence"]),
  oldMode: z.string().regex(/^[0-7]{6}$/),
  newMode: z.string().regex(/^[0-7]{6}$/),
  oldObjectId: gitRevisionSchema,
  newObjectId: gitRevisionSchema,
  status: z.enum(["A", "D", "M", "T"]),
});
export type ReviewTreeChange = z.infer<typeof reviewTreeChangeSchema>;

export const reviewEvidenceBatchSchema = z
  .strictObject({
    scopeIdentity: reviewScopeIdentitySchema,
    ordinal: z.number().int().positive().max(REVIEW_GIT_LIMITS.batches),
    status: z.literal("complete"),
    paths: reviewScopePathListSchema
      .min(1)
      .max(REVIEW_GIT_LIMITS.eligiblePaths),
    patch: z.string(),
    changeEvidence: z.string(),
    hunkCount: z.number().int().nonnegative().max(REVIEW_GIT_LIMITS.hunks),
    patchBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REVIEW_GIT_LIMITS.batchBytes),
    changeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REVIEW_GIT_LIMITS.batchBytes),
  })
  .superRefine((batch, ctx) => {
    if (
      batch.patchBytes !== Buffer.byteLength(batch.patch) ||
      batch.changeBytes !== Buffer.byteLength(batch.changeEvidence) ||
      batch.patchBytes + batch.changeBytes > REVIEW_GIT_LIMITS.batchBytes ||
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
    const paths = evidence.batches.flatMap((batch) => batch.paths);
    const eligible = new Set(evidence.eligiblePaths);
    const excluded = new Set(evidence.excludedPaths);
    const reviewable = new Set(evidence.reviewablePaths);
    const treeKeys = evidence.treeChanges.map((entry) =>
      JSON.stringify([entry.path, entry.evidenceForm]),
    );
    const forms =
      "checkpointRevision" in evidence.scopeIdentity
        ? ["review-patch", "change-evidence"]
        : ["review-patch"];
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
      paths.length !== reviewable.size ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => !reviewable.has(path)) ||
      evidence.batches.some(
        (batch, index) =>
          batch.ordinal !== index + 1 ||
          JSON.stringify(batch.scopeIdentity) !==
            JSON.stringify(evidence.scopeIdentity),
      ) ||
      evidence.evidenceBytes !==
        evidence.batches.reduce(
          (sum, batch) => sum + batch.patchBytes + batch.changeBytes,
          0,
        ) ||
      evidence.hunkCount !==
        evidence.batches.reduce((sum, batch) => sum + batch.hunkCount, 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Scope evidence accounting is inconsistent",
      });
    }
  });
export type ReviewScopeEvidence = z.infer<typeof reviewScopeEvidenceSchema>;
