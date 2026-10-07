import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { runReviewGit } from "./review-git-process.js";
import { reviewGitEnvironment } from "./review-git-host-policy.js";

const cwd = tmpdir();
const env = reviewGitEnvironment(cwd);
const argv = ["-c", "alias.fixture=!printf a; printf b >&2", "fixture"];

describe("native Git process limits", () => {
  it("preserves raw output at the combined boundary and rejects one byte over", async () => {
    const result = await runReviewGit(cwd, env, {
      argv,
      limits: { wallMs: 3000, outputBytes: 2 },
    });
    expect(Buffer.from(result.stdout).toString()).toBe("a");
    expect(Buffer.from(result.stderr).toString()).toBe("b");
    expect(result.usage.wallMs).toBeGreaterThan(0);
    await expect(
      runReviewGit(cwd, env, {
        argv,
        limits: { wallMs: 3000, outputBytes: 1 },
      }),
    ).rejects.toMatchObject({ resource: "outputBytes", observed: 2, limit: 1 });
  });
  it("stops a stalled Git command and its helper on timeout", async () => {
    await expect(
      runReviewGit(cwd, env, {
        argv: ["-c", "alias.fixture=!sleep 10", "fixture"],
        limits: { wallMs: 100, outputBytes: 100 },
      }),
    ).rejects.toMatchObject({ resource: "commandWallMs", limit: 100 });
  });
  it("honors cancellation before and during execution", async () => {
    const controller = new AbortController();
    const pending = runReviewGit(cwd, env, {
      argv: ["-c", "alias.fixture=!sleep 10", "fixture"],
      limits: { wallMs: 3000, outputBytes: 100 },
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "REVIEW_SCOPE_CANCELLED",
      cause: "stopped",
    });
    controller.abort("stopped");
    await rejected;
    await expect(
      runReviewGit(cwd, env, {
        argv,
        limits: { wallMs: 3000, outputBytes: 100 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_SCOPE_CANCELLED" });
  });
  it("preserves nonzero Git exit status and types a spawn failure", async () => {
    expect(
      (
        await runReviewGit(cwd, env, {
          argv: ["cat-file", "-t", "missing"],
          limits: { wallMs: 3000, outputBytes: 1000 },
        })
      ).exitCode,
    ).not.toBe(0);
    await expect(
      runReviewGit("/missing-seqlane-checkout", env, {
        argv,
        limits: { wallMs: 3000, outputBytes: 100 },
      }),
    ).rejects.toMatchObject({ code: "GIT_HOST_FAILED" });
  });
});
