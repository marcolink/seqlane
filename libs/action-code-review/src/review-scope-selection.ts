import {
  reviewScopeIdentitySchema,
  reviewScopePathListSchema,
  reviewScopeSelectionSchema,
  REVIEW_GIT_LIMITS,
  type ReviewScopeSelection,
} from "./review-scope-contracts.js";
import { requireScopeLimit, ReviewScopeError } from "./review-scope-errors.js";

const excludedNames = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
]);

export function selectReviewScope(
  identityValue: unknown,
  prPathsValue: unknown,
  changedPathsValue: unknown = [],
): ReviewScopeSelection {
  const scopeIdentity = reviewScopeIdentitySchema.parse(identityValue);
  const prPaths = reviewScopePathListSchema.parse(prPathsValue);
  const changedPaths = new Set(
    reviewScopePathListSchema.parse(changedPathsValue),
  );
  const hasCheckpoint = "checkpointRevision" in scopeIdentity;
  const eligiblePaths = [...new Set(prPaths)]
    .filter((path) => !hasCheckpoint || changedPaths.has(path))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
  requireScopeLimit(
    "eligiblePaths",
    eligiblePaths.length,
    REVIEW_GIT_LIMITS.eligiblePaths,
    "scope-selection",
  );
  if (scopeIdentity.mode === "no-change" && eligiblePaths.length !== 0) {
    throw new ReviewScopeError(
      "SCOPE_IDENTITY_MISMATCH",
      "No-change scope contains changed PR paths.",
    );
  }
  const excludedPaths: string[] = [];
  const reviewablePaths: string[] = [];
  for (const path of eligiblePaths) {
    const parts = path.split("/");
    const excluded =
      excludedNames.has(parts.at(-1) ?? "") ||
      parts.slice(0, -1).includes("dist");
    (excluded ? excludedPaths : reviewablePaths).push(path);
  }
  return reviewScopeSelectionSchema.parse({
    scopeIdentity,
    eligiblePaths,
    excludedPaths,
    reviewablePaths,
  });
}
