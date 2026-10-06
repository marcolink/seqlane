import { ZodError } from "zod";
import {
  reviewScopeIdentitySchema,
  type ReviewPathPatch,
  type ReviewScopeIdentity,
  type ReviewScopeEvidence,
  type ReviewTreeChange,
} from "./review-scope-contracts.js";
import {
  ReviewGitBudget,
  type BoundedReviewGitPort,
} from "./review-git-budget.js";
import {
  decodeGitBytes,
  parseGitPaths,
  parseScopedGitPatches,
} from "./review-git-records.js";
import { ReviewScopeError } from "./review-scope-errors.js";
import { aggregateReviewScopeEvidence } from "./review-evidence-batches.js";
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
    const fetch = await budget.fetchExactCommit(revision);
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

async function readPatches(
  budget: ReviewGitBudget,
  revisions: readonly string[],
  paths: readonly string[],
  evidenceForm: ReviewTreeChange["evidenceForm"],
): Promise<ReviewPathPatch[]> {
  if (paths.length === 0) return [];
  const output = await requiredGitOutput(budget, [
    "-c",
    "core.quotePath=true",
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
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    "--submodule=short",
    "--output-indicator-new=+",
    "--output-indicator-old=-",
    "--output-indicator-context= ",
    ...revisions,
    "--",
    ...paths,
  ]);
  return parseScopedGitPatches(output, paths, evidenceForm);
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
  const reviewPatches = await readPatches(
    budget,
    changeRange ?? prRange,
    selection.reviewablePaths,
    changeRange === undefined ? "pr-patch" : "change-evidence",
  );
  const validationPatches =
    changeRange === undefined
      ? []
      : await readPatches(
          budget,
          prRange,
          selection.reviewablePaths,
          "pr-patch",
        );
  const evidence = aggregateReviewScopeEvidence(selection, {
    review: reviewPatches,
    validation: validationPatches,
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
