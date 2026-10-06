import {
  REVIEW_GIT_LIMITS,
  reviewScopeEvidenceSchema,
  type ReviewEvidenceBatch,
  type ReviewPathPatch,
  type ReviewScopeIdentity,
  type ReviewScopeSelection,
  type ReviewTreeChange,
} from "./review-scope-contracts.js";
import { requireScopeLimit } from "./review-scope-errors.js";

function appendBatch(
  batches: ReviewEvidenceBatch[],
  scopeIdentity: ReviewScopeIdentity,
  part: { path: string; patch: string; hunkCount: number },
): void {
  const { path, patch, hunkCount } = part;
  const patchBytes = Buffer.byteLength(patch);
  requireScopeLimit(
    "batchBytes",
    patchBytes,
    REVIEW_GIT_LIMITS.batchBytes,
    "single-path-evidence",
  );
  let batch = batches.at(-1);
  if (
    batch === undefined ||
    batch.patchBytes + patchBytes > REVIEW_GIT_LIMITS.batchBytes
  ) {
    requireScopeLimit(
      "batches",
      batches.length + 1,
      REVIEW_GIT_LIMITS.batches,
      "evidence-batching",
    );
    batch = {
      scopeIdentity,
      ordinal: batches.length + 1,
      status: "complete",
      paths: [],
      patch: "",
      hunkCount: 0,
      patchBytes: 0,
    };
    batches.push(batch);
  }
  batch.paths.push(path);
  batch.patch += patch;
  batch.hunkCount += hunkCount;
  batch.patchBytes += patchBytes;
}

/** Pure accounting: discovery and local validation share limits, not model input. */
export function aggregateReviewScopeEvidence(
  selection: ReviewScopeSelection,
  groups: {
    review: ReviewPathPatch[];
    validation: ReviewPathPatch[];
  },
) {
  const batches: ReviewEvidenceBatch[] = [];
  const validationBatches: ReviewEvidenceBatch[] = [];
  const treeChanges: ReviewTreeChange[] = [];
  let evidenceBytes = 0;
  let hunkCount = 0;
  for (const [patches, destination] of [
    [groups.review, batches],
    [groups.validation, validationBatches],
  ] as const) {
    for (const part of patches) {
      treeChanges.push(part.treeChange);
      evidenceBytes += Buffer.byteLength(part.patch);
      hunkCount += part.hunkCount;
      requireScopeLimit(
        "evidenceBytes",
        evidenceBytes,
        REVIEW_GIT_LIMITS.evidenceBytes,
        "scope-evidence",
      );
      requireScopeLimit(
        "hunks",
        hunkCount,
        REVIEW_GIT_LIMITS.hunks,
        "scope-evidence",
      );
      appendBatch(destination, selection.scopeIdentity, {
        path: part.treeChange.path,
        patch: part.patch,
        hunkCount: part.hunkCount,
      });
      requireScopeLimit(
        "batches",
        batches.length + validationBatches.length,
        REVIEW_GIT_LIMITS.batches,
        "evidence-batching",
      );
    }
  }
  return reviewScopeEvidenceSchema.parse({
    ...selection,
    batches,
    validationBatches,
    treeChanges,
    evidenceBytes,
    hunkCount,
  });
}
