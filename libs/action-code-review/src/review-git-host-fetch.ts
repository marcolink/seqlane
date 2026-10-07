import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  reviewGitResultSchema,
  type ReviewGitRequest,
} from "./review-git-budget.js";
import { fetchCheckpointPack } from "./review-git-transport.js";
import { ReviewScopeError } from "./review-scope-errors.js";
import type { ReviewGitHostOptions } from "./review-git-host-policy.js";
import type { superviseReviewGit } from "./review-git-supervisor.js";

/** Install a metered pack with Git, without moving HEAD, index, or worktree. */
export async function installReviewCheckpoint(
  options: {
    readonly home: string;
    readonly remote: NonNullable<ReviewGitHostOptions["trustedRemote"]>;
    readonly supervise: (
      request: ReviewGitRequest,
      inputPath?: string,
    ) => ReturnType<typeof superviseReviewGit>;
  },
  revision: string,
  request: ReviewGitRequest & { readonly signal: AbortSignal },
) {
  if (request.argv.length !== 1 || request.argv[0] !== "--no-replace-objects")
    throw new ReviewScopeError(
      "GIT_HOST_COMMAND",
      "Exact fetch accepts no caller-selected Git options.",
    );
  const started = performance.now();
  const received = await fetchCheckpointPack(
    options.remote,
    revision,
    request.limits,
    request.signal,
  );
  const inputPath = join(options.home, "checkpoint.pack");
  try {
    await writeFile(inputPath, received.pack, { mode: 0o600 });
    const wallMs = request.limits.wallMs - (performance.now() - started);
    if (wallMs <= 0)
      throw new ReviewScopeError(
        "REVIEW_SCOPE_BUDGET_EXHAUSTED",
        "No checkpoint-fetch execution budget remains.",
      );
    const result = await options.supervise(
      {
        ...request,
        argv: ["--no-replace-objects", "index-pack", "--stdin"],
        limits: { ...request.limits, wallMs },
      },
      inputPath,
    );
    return reviewGitResultSchema.parse({
      ...result,
      usage: {
        ...result.usage,
        wallMs: performance.now() - started,
        transferBytes: received.transferBytes,
      },
    });
  } finally {
    await rm(inputPath, { force: true });
  }
}
