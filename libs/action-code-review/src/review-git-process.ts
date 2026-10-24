import { spawn } from "node:child_process";
import { z } from "zod";
import {
  reviewGitResultSchema,
  type ReviewGitRequest,
} from "./review-git-budget.js";
import { REVIEW_GIT_LIMITS } from "./review-scope-contracts.js";
import {
  ReviewScopeError,
  ReviewScopeLimitError,
} from "./review-scope-errors.js";

const reviewGitRequestSchema = z.strictObject({
  argv: z.array(z.string().refine((value) => !value.includes("\0"))),
  limits: z.strictObject({
    wallMs: z.number().positive().max(REVIEW_GIT_LIMITS.commandWallMs),
    outputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REVIEW_GIT_LIMITS.outputBytes),
  }),
  signal: z.instanceof(AbortSignal).optional(),
});

/** Native Git; ordinary process groups cover its transport helpers on POSIX. */
export async function runReviewGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  request: ReviewGitRequest,
) {
  const parsed = reviewGitRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new ReviewScopeError(
      "GIT_REQUEST_INVALID",
      "Review Git request is invalid.",
      parsed.error,
    );
  request = parsed.data;
  return new Promise<z.output<typeof reviewGitResultSchema>>(
    (resolve, reject) => {
      if (request.signal?.aborted) {
        reject(
          new ReviewScopeError(
            "REVIEW_SCOPE_CANCELLED",
            "Git was cancelled.",
            request.signal.reason,
          ),
        );
        return;
      }
      const started = performance.now();
      const child = spawn("git", [...request.argv], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: ReviewScopeError | undefined;
      let terminationFailure: unknown;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: ReviewScopeError) => {
        failure ??= error;
        if (child.pid === undefined) return;
        // The leader may exit before helpers release the inherited pipes.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          if (!z.object({ code: z.literal("ESRCH") }).safeParse(cause).success)
            terminationFailure = cause;
        }
        cleanupTimer ??= setTimeout(() => {
          failure = new ReviewScopeError(
            "GIT_CLEANUP_FAILED",
            "Git cleanup did not finish within one second.",
            terminationFailure ?? failure,
          );
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        }, 1000);
      };
      const abort = () =>
        stop(
          new ReviewScopeError(
            "REVIEW_SCOPE_CANCELLED",
            "Git was cancelled.",
            request.signal?.reason,
          ),
        );
      const timer = setTimeout(
        () =>
          stop(
            new ReviewScopeLimitError(
              "commandWallMs",
              performance.now() - started,
              request.limits.wallMs,
              "git",
            ),
          ),
        request.limits.wallMs,
      );
      request.signal?.addEventListener("abort", abort, { once: true });
      const receive = (chunks: Buffer[], chunk: Buffer) => {
        if (failure !== undefined) return;
        bytes += chunk.byteLength;
        if (bytes > request.limits.outputBytes)
          stop(
            new ReviewScopeLimitError(
              "outputBytes",
              bytes,
              request.limits.outputBytes,
              "git",
            ),
          );
        else chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
      child.on("error", (cause) => {
        failure ??= new ReviewScopeError(
          "GIT_HOST_FAILED",
          "Git could not run.",
          cause,
        );
      });
      const finish = (exitCode: number | null) => {
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        request.signal?.removeEventListener("abort", abort);
        if (failure !== undefined) reject(failure);
        else if (exitCode === null)
          reject(
            new ReviewScopeError(
              "GIT_HOST_FAILED",
              "Git exited without a status.",
            ),
          );
        else
          resolve({
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            stdoutTruncated: false,
            stderrTruncated: false,
            usage: { wallMs: performance.now() - started },
          });
      };
      child.once("close", finish);
    },
  );
}
