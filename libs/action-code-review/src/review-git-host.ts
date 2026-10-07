import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoundedReviewGitPort,
  type ReviewGitRequest,
} from "./review-git-budget.js";
import {
  reviewGitEnvironment,
  requireLocalReviewGit,
  REVIEW_GIT_HOST_ARGS,
  type ReviewGitHostOptions,
} from "./review-git-host-policy.js";
import { reviewGitRequestSchema, runReviewGit } from "./review-git-process.js";
import { installReviewCheckpoint } from "./review-git-host-fetch.js";
import { reviewGitHostOptionsSchema } from "./review-git-host-policy.js";
import { ReviewScopeError } from "./review-scope-errors.js";

export interface ReviewGitHost {
  readonly git: BoundedReviewGitPort;
  close(): Promise<void>;
}

/** Private native Git adapter for Linux and macOS. */
export async function createReviewGitHost(
  optionsValue: ReviewGitHostOptions,
): Promise<ReviewGitHost> {
  const validation = reviewGitHostOptionsSchema.safeParse(optionsValue);
  if (!validation.success)
    throw new ReviewScopeError(
      "GIT_HOST_SETUP_FAILED",
      "Git host options are invalid.",
      validation.error,
    );
  const options = validation.data;
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new ReviewScopeError(
      "GIT_HOST_UNSUPPORTED",
      "Review Git requires Linux or macOS.",
    );
  const cwd = await realpath(options.reviewTarget).catch((cause: unknown) => {
    throw new ReviewScopeError(
      "GIT_HOST_SETUP_FAILED",
      "The review checkout is unavailable.",
      cause,
    );
  });
  const home = await mkdtemp(join(tmpdir(), "seqlane-review-git-")).catch(
    (cause: unknown) => {
      throw new ReviewScopeError(
        "GIT_HOST_SETUP_FAILED",
        "The Git host could not create its owned temporary directory.",
        cause,
      );
    },
  );
  const lifetime = new AbortController();
  const signal =
    options.signal === undefined
      ? lifetime.signal
      : AbortSignal.any([lifetime.signal, options.signal]);
  let active: Promise<unknown> | undefined;
  const run = (request: ReviewGitRequest) =>
    runReviewGit(cwd, reviewGitEnvironment(home), {
      ...request,
      argv: [...REVIEW_GIT_HOST_ARGS, ...request.argv],
    });
  const perform = async (
    request: ReviewGitRequest,
    action: (
      request: ReviewGitRequest & { readonly signal: AbortSignal },
    ) => Promise<unknown>,
  ) => {
    if (active !== undefined)
      throw new ReviewScopeError(
        "GIT_HOST_BUSY",
        "The bounded Git host permits one operation at a time.",
      );
    const validation = reviewGitRequestSchema.safeParse(request);
    if (!validation.success)
      throw new ReviewScopeError(
        "GIT_HOST_REQUEST",
        "The bounded Git request is invalid.",
        validation.error,
      );
    const parsed = validation.data;
    const bounded = {
      ...parsed,
      signal:
        parsed.signal === undefined
          ? signal
          : AbortSignal.any([signal, parsed.signal]),
    };
    if (bounded.signal.aborted)
      throw new ReviewScopeError(
        "REVIEW_SCOPE_CANCELLED",
        "Git was cancelled.",
        bounded.signal.reason,
      );
    active = action(bounded);
    try {
      return await active;
    } catch (cause) {
      if (cause instanceof ReviewScopeError) throw cause;
      throw new ReviewScopeError(
        "GIT_HOST_FAILED",
        "The bounded Git operation failed.",
        cause,
      );
    } finally {
      active = undefined;
    }
  };
  const git: BoundedReviewGitPort = {
    run: (request) =>
      perform(request, async (bounded) => {
        requireLocalReviewGit(bounded.argv);
        return run(bounded);
      }),
  };
  const remote = options.trustedRemote;
  if (remote !== undefined)
    git.fetchExactCommit = (revision, request) =>
      perform(request, (bounded) =>
        installReviewCheckpoint({ home, cwd, remote }, revision, bounded),
      );
  return {
    git,
    close: async () => {
      lifetime.abort(
        new ReviewScopeError(
          "REVIEW_SCOPE_CANCELLED",
          "The Git host was closed.",
        ),
      );
      await active?.catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    },
  };
}
