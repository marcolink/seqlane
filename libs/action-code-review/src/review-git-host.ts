import { mkdtemp, rm } from "node:fs/promises";
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
import {
  reviewGitRequestSchema,
  superviseReviewGit,
} from "./review-git-supervisor.js";
import { installReviewCheckpoint } from "./review-git-host-fetch.js";
import {
  prepareReviewGitHost,
  requireReviewGitActive,
} from "./review-git-host-preflight.js";
import { ReviewScopeError } from "./review-scope-errors.js";

export interface ReviewGitHost {
  readonly git: BoundedReviewGitPort;
  close(): Promise<void>;
}

/** Private Linux host. cgroupRoot is provisioned by trusted runner setup. */
export async function createReviewGitHost(
  optionsValue: ReviewGitHostOptions,
): Promise<ReviewGitHost> {
  const { options, cwd, cgroupRoot } = await prepareReviewGitHost(optionsValue);
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
  const supervise = (request: ReviewGitRequest, inputPath?: string) =>
    superviseReviewGit(
      {
        cwd,
        cgroupRoot,
        executable: "/usr/bin/git",
        env: reviewGitEnvironment(home),
        ...(inputPath === undefined ? {} : { inputPath }),
      },
      {
        ...request,
        argv: [...REVIEW_GIT_HOST_ARGS, ...request.argv],
        signal:
          request.signal === undefined
            ? signal
            : AbortSignal.any([signal, request.signal]),
      },
    );
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
    requireReviewGitActive(bounded.signal);
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
        return supervise(bounded);
      }),
    ...(options.trustedRemote === undefined
      ? {}
      : {
          fetchExactCommit: (revision: string, request: ReviewGitRequest) =>
            perform(request, async (bounded) => {
              const remote = options.trustedRemote;
              if (remote === undefined)
                throw new ReviewScopeError(
                  "CHECKPOINT_UNAVAILABLE",
                  "No trusted checkpoint remote is configured.",
                );
              return installReviewCheckpoint(
                { home, remote, supervise },
                revision,
                bounded,
              );
            }),
        }),
  };
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
