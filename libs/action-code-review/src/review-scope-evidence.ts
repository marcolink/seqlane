import { ZodError } from "zod";
import {
  REVIEW_GIT_LIMITS,
  reviewScopeIdentitySchema,
  reviewScopeEvidenceSchema,
  type ReviewScopeIdentity,
  type ReviewScopeEvidence,
  type ReviewEvidenceBatch,
  type ReviewTreeChange,
} from "./review-scope-contracts.js";
import {
  ReviewGitBudget,
  type BoundedReviewGitPort,
} from "./review-git-budget.js";
import {
  decodeGitBytes,
  parseGitPaths,
  parseScopedGitPatch,
} from "./review-git-records.js";
import { requireScopeLimit, ReviewScopeError } from "./review-scope-errors.js";
import { selectReviewScope } from "./review-scope-selection.js";

const diffOptions = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
  "--ignore-submodules=none",
];

async function requireCommit(
  budget: ReviewGitBudget,
  revision: string,
  fetchMissing: boolean,
): Promise<void> {
  let result = await budget.run(["cat-file", "-t", revision]);
  if (result.exitCode !== 0 && fetchMissing) {
    const fetch = await budget.run([], revision);
    if (fetch.exitCode !== 0) {
      throw new ReviewScopeError(
        "CHECKPOINT_UNAVAILABLE",
        "Git could not fetch the exact checkpoint.",
      );
    }
    result = await budget.run(["cat-file", "-t", revision]);
  }
  if (
    result.exitCode !== 0 ||
    decodeGitBytes(result.stdout).trim() !== "commit"
  ) {
    throw new ReviewScopeError(
      "COMMIT_REQUIRED",
      "Review revisions must name exact commit objects.",
    );
  }
}

async function requiredGitOutput(
  budget: ReviewGitBudget,
  argv: readonly string[],
): Promise<Uint8Array> {
  const result = await budget.run(argv);
  if (result.exitCode !== 0) {
    throw new ReviewScopeError(
      "GIT_EVIDENCE_FAILED",
      "Git could not collect complete scope evidence.",
    );
  }
  return result.stdout;
}

async function readPaths(
  budget: ReviewGitBudget,
  revisions: readonly string[],
): Promise<string[]> {
  const output = await requiredGitOutput(budget, [
    "diff",
    ...diffOptions,
    "--name-status",
    "-z",
    ...revisions,
    "--",
  ]);
  return parseGitPaths(output);
}

async function readPatch(
  budget: ReviewGitBudget,
  revisions: readonly string[],
  path: string,
  evidenceForm: ReviewTreeChange["evidenceForm"],
): Promise<ReturnType<typeof parseScopedGitPatch>> {
  const output = await requiredGitOutput(budget, [
    "--literal-pathspecs",
    "diff",
    ...diffOptions,
    "--raw",
    "-z",
    "--patch",
    "--no-abbrev",
    "--full-index",
    "--binary",
    "--unified=10",
    ...revisions,
    "--",
    path,
  ]);
  return parseScopedGitPatch(output, path, evidenceForm);
}

function appendBatch(
  batches: ReviewEvidenceBatch[],
  scopeIdentity: ReviewScopeIdentity,
  part: {
    path: string;
    patch: string;
    changeEvidence: string;
    hunkCount: number;
  },
): void {
  const { path, patch, changeEvidence, hunkCount } = part;
  const patchBytes = Buffer.byteLength(patch);
  const changeBytes = Buffer.byteLength(changeEvidence);
  requireScopeLimit(
    "batchBytes",
    patchBytes + changeBytes,
    REVIEW_GIT_LIMITS.batchBytes,
    "single-path-evidence",
  );
  let batch = batches.at(-1);
  if (
    batch === undefined ||
    batch.patchBytes + batch.changeBytes + patchBytes + changeBytes >
      REVIEW_GIT_LIMITS.batchBytes
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
      changeEvidence: "",
      hunkCount: 0,
      patchBytes: 0,
      changeBytes: 0,
    };
    batches.push(batch);
  }
  batch.paths.push(path);
  batch.patch += patch;
  batch.changeEvidence += changeEvidence;
  batch.hunkCount += hunkCount;
  batch.patchBytes += patchBytes;
  batch.changeBytes += changeBytes;
}

async function collect(
  identity: ReviewScopeIdentity,
  budget: ReviewGitBudget,
): Promise<ReviewScopeEvidence> {
  await requireCommit(budget, identity.baseRevision, false);
  await requireCommit(budget, identity.headRevision, false);
  const head = await budget.run(["rev-parse", "--verify", "HEAD"]);
  if (
    head.exitCode !== 0 ||
    decodeGitBytes(head.stdout).trim() !== identity.headRevision
  ) {
    throw new ReviewScopeError(
      "HEAD_MISMATCH",
      "Git HEAD differs from the frozen review head.",
    );
  }
  const prRange = [`${identity.baseRevision}...${identity.headRevision}`];
  const changeRange =
    "checkpointRevision" in identity
      ? [identity.checkpointRevision, identity.headRevision]
      : undefined;
  if ("checkpointRevision" in identity)
    await requireCommit(budget, identity.checkpointRevision, true);
  const prPaths = await readPaths(budget, prRange);
  const changedPaths =
    changeRange === undefined ? [] : await readPaths(budget, changeRange);
  const selection = selectReviewScope(identity, prPaths, changedPaths);
  const batches: ReviewEvidenceBatch[] = [];
  const treeChanges: ReviewTreeChange[] = [];
  let evidenceBytes = 0;
  let hunkCount = 0;
  for (const path of selection.reviewablePaths) {
    const context = await readPatch(budget, prRange, path, "review-patch");
    treeChanges.push(context.treeChange);
    const change =
      changeRange === undefined
        ? { patch: "", hunkCount: 0 }
        : await readPatch(budget, changeRange, path, "change-evidence");
    if ("treeChange" in change) treeChanges.push(change.treeChange);
    evidenceBytes +=
      Buffer.byteLength(context.patch) + Buffer.byteLength(change.patch);
    hunkCount += context.hunkCount + change.hunkCount;
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
    appendBatch(batches, identity, {
      path,
      patch: context.patch,
      changeEvidence: change.patch,
      hunkCount: context.hunkCount + change.hunkCount,
    });
  }
  const evidence = reviewScopeEvidenceSchema.parse({
    ...selection,
    batches,
    treeChanges,
    evidenceBytes,
    hunkCount,
  });
  budget.assertActive("scope-finalization");
  return evidence;
}

/** Input is a trusted admission, never a v4 report or a model-supplied checkpoint. */
export async function collectReviewScopeEvidence(
  identityValue: unknown,
  host: {
    readonly git: BoundedReviewGitPort;
    readonly admittedAt: number;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
  },
): Promise<ReviewScopeEvidence> {
  try {
    const identity = reviewScopeIdentitySchema.parse(identityValue);
    const now = host.now ?? (() => performance.now());
    if (!Number.isFinite(host.admittedAt) || host.admittedAt > now()) {
      throw new ReviewScopeError(
        "INVALID_ADMISSION_TIME",
        "Review admission time is invalid.",
      );
    }
    return await collect(
      identity,
      new ReviewGitBudget(host.git, host.admittedAt, now, host.signal),
    );
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      cause instanceof ZodError ? "REVIEW_SCOPE_INVALID" : "GIT_SCOPE_FAILED",
      "Review scope collection failed.",
      cause,
    );
  }
}
