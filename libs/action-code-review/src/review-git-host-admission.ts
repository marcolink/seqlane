import { createReviewGitHost } from "./review-git-host.js";
import {
  reviewGitHostOptionsSchema,
  type ReviewGitHostOptions,
} from "./review-git-host-policy.js";
import { admitReviewScope } from "./review-scope-admission.js";
import type { ReviewAuthorityReadPort } from "./review-report-authority.js";
import { REVIEW_GIT_LIMITS } from "./review-scope-contracts.js";
import {
  ReviewScopeError,
  ReviewScopeLimitError,
} from "./review-scope-errors.js";

/** Trusted caller binds this signal to raw authority HTTP requests, without retries. */
export async function admitReviewScopeWithGitHost(
  input: unknown,
  options: ReviewGitHostOptions,
  createAuthority: (signal: AbortSignal) => ReviewAuthorityReadPort,
) {
  const validation = reviewGitHostOptionsSchema.safeParse(options);
  if (!validation.success)
    throw new ReviewScopeError(
      "GIT_HOST_SETUP_FAILED",
      "Hosted admission options are invalid.",
      validation.error,
    );
  const deadline = createReviewAdmissionDeadline(validation.data.signal);
  const { admittedAt, signal } = deadline;
  let host: Awaited<ReturnType<typeof createReviewGitHost>> | undefined;
  try {
    host = await createReviewGitHost({ ...options, signal });
    const port = createAuthority(signal);
    const authority: ReviewAuthorityReadPort = {
      listIssueComments: (...args) =>
        waitForReviewAuthority(port.listIssueComments(...args), signal),
    };
    return await admitReviewScope(input, {
      authority,
      git: host.git,
      admittedAt,
      signal,
    });
  } catch (cause) {
    if (deadline.controller.signal.aborted && !options.signal?.aborted)
      throw deadline.controller.signal.reason;
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "REVIEW_ADMISSION_FAILED",
      "Hosted review admission failed.",
      cause,
    );
  } finally {
    deadline.close();
    await host?.close();
  }
}

/** Abort also settles a defective authority port that never resolves. */
export async function waitForReviewAuthority<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new ReviewScopeError(
          "REVIEW_ADMISSION_CANCELLED",
          "Review authority read was cancelled.",
          signal.reason,
        ),
      );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Starts before host setup; collection keeps this same absolute deadline. */
export function createReviewAdmissionDeadline(parentSignal?: AbortSignal) {
  const admittedAt = performance.now();
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new ReviewScopeLimitError(
          "admissionWallMs",
          performance.now() - admittedAt,
          REVIEW_GIT_LIMITS.admissionWallMs,
          "review-admission",
        ),
      ),
    REVIEW_GIT_LIMITS.admissionWallMs,
  );
  const signal =
    parentSignal === undefined
      ? deadline.signal
      : AbortSignal.any([parentSignal, deadline.signal]);
  return {
    admittedAt,
    signal,
    controller: deadline,
    close: () => clearTimeout(timer),
  };
}
