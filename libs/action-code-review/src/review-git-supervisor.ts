import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { ReviewGitRequest } from "./review-git-budget.js";
import { ReviewScopeError } from "./review-scope-errors.js";
import { REVIEW_GIT_SUPERVISOR_SOURCE } from "./review-git-supervisor-source.js";
import { REVIEW_GIT_LIMITS } from "./review-scope-contracts.js";
import { requireReviewGitActive } from "./review-git-host-preflight.js";
import { parseReviewGitSupervisorResult } from "./review-git-supervisor-result.js";
import { removeReviewGitGroup } from "./review-git-supervisor-cleanup.js";

export const reviewGitRequestSchema = z.strictObject({
  argv: z.array(z.string().max(4096)).max(256).readonly(),
  limits: z.strictObject({
    wallMs: z.number().positive().max(REVIEW_GIT_LIMITS.commandWallMs),
    cpuMs: z.number().positive().max(REVIEW_GIT_LIMITS.totalCpuMs),
    peakMemoryBytes: z
      .number()
      .int()
      .positive()
      .max(REVIEW_GIT_LIMITS.peakMemoryBytes),
    outputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REVIEW_GIT_LIMITS.outputBytes),
    transferBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REVIEW_GIT_LIMITS.fetchBytes),
  }),
  signal: z.instanceof(AbortSignal).optional(),
});

export interface ReviewGitSupervisorOptions {
  readonly cwd: string;
  readonly cgroupRoot: string;
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inputPath?: string;
}

/** Internal trusted process seam. Production callers select Git, never target code. */
export async function superviseReviewGit(
  options: ReviewGitSupervisorOptions,
  requestValue: ReviewGitRequest,
) {
  const request = reviewGitRequestSchema.parse(requestValue);
  requireReviewGitActive(request.signal);
  if (process.platform !== "linux") {
    throw new ReviewScopeError(
      "GIT_HOST_UNSUPPORTED",
      "The bounded Git host requires Linux cgroup v2.",
    );
  }
  const operation =
    options.inputPath === undefined ? "local-git" : "exact-checkpoint-fetch";
  const groupId = `seqlane-${randomUUID()}`;
  const group = join(options.cgroupRoot, groupId);
  const child = spawn(
    "/usr/bin/python3",
    ["-I", "-c", REVIEW_GIT_SUPERVISOR_SOURCE],
    {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  let rejectedOutput = false;
  // Raw stdout/stderr are base64 in one bounded envelope. This is a transport
  // bound, separate from the supervisor's combined raw Git-output ceiling.
  const envelopeLimit =
    Math.ceil((request.limits.outputBytes * 4) / 3) + 16_384;
  const abort = () => child.stdin.end();
  const guard = setTimeout(() => {
    abort();
    child.kill("SIGTERM");
  }, request.limits.wallMs + 1000);
  const emergency = setTimeout(() => {
    // Kill descendants first, then the stuck supervisor. Final cleanup is awaited.
    void removeReviewGitGroup(group)
      .catch(() => undefined)
      .finally(() => child.kill("SIGKILL"));
  }, request.limits.wallMs + 2000);
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    const completion = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdin.on("error", () => undefined); // The completed supervisor may close first.
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > envelopeLimit) {
          rejectedOutput = true;
          abort();
        } else chunks.push(chunk);
      });
      // Supervisor diagnostics contain no target output or credentials.
      child.stderr.resume();
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new ReviewScopeError(
                "GIT_SUPERVISOR_FAILED",
                "Git supervision did not complete.",
              ),
            ),
      );
    });
    child.stdin.write(
      JSON.stringify({
        ...options,
        argv: request.argv,
        limits: request.limits,
        groupId,
      }) + "\n",
    );
    await completion;
    if (rejectedOutput)
      throw new ReviewScopeError(
        "GIT_SUPERVISOR_OUTPUT",
        "Git supervisor output exceeded its envelope bound.",
      );
    return parseReviewGitSupervisorResult(
      Buffer.concat(chunks),
      operation,
      request.signal,
    );
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "GIT_SUPERVISOR_FAILED",
      "Git supervision failed.",
      cause,
    );
  } finally {
    clearTimeout(guard);
    clearTimeout(emergency);
    request.signal?.removeEventListener("abort", abort);
    child.stdin.end();
    await removeReviewGitGroup(group);
  }
}
