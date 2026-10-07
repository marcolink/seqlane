import type { BoundedReviewGitPort } from "./review-git-budget.js";
import {
  reviewGitOptionsSchema,
  reviewGitEnvironment,
  REVIEW_GIT_ARGS,
  type ReviewGitOptions,
} from "./review-git-config.js";
import { runReviewGit } from "./review-git-process.js";
import { installReviewCheckpoint } from "./review-git-fetch.js";
import { ReviewScopeError } from "./review-scope-errors.js";

/** Only trusted collector code constructs local argv; this is not a command API. */
export function createReviewGitAdapter(
  optionsValue: ReviewGitOptions,
): BoundedReviewGitPort {
  const parsed = reviewGitOptionsSchema.safeParse(optionsValue);
  if (!parsed.success)
    throw new ReviewScopeError(
      "GIT_CONFIGURATION_INVALID",
      "Review Git configuration is invalid.",
      parsed.error,
    );
  const { reviewTarget, trustedRemote } = parsed.data;
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new ReviewScopeError(
      "GIT_HOST_UNSUPPORTED",
      "Review Git requires Linux or macOS.",
    );
  return {
    run: (request) =>
      runReviewGit(reviewTarget, reviewGitEnvironment(), {
        ...request,
        argv: [...REVIEW_GIT_ARGS, ...request.argv],
      }),
    ...(trustedRemote === undefined
      ? {}
      : {
          fetchExactCommit: (revision, request) =>
            installReviewCheckpoint(
              { cwd: reviewTarget, remote: trustedRemote },
              revision,
              request,
            ),
        }),
  };
}
