// @test-scope ./review-scope-admission.ts
// @test-scope ./review-report-authority.ts
import { describe, expect, it, vi } from "vitest";
import { admitReviewScope } from "./review-scope-admission.js";
import { ReviewScopeError } from "./review-scope-errors.js";

const input = {
  pullRequest: {
    repositoryId: "1",
    pullRequestNumber: 112,
    targetBranch: "release",
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
  },
};

describe("admission deadline", () => {
  it("preserves unconfirmed Git cleanup when the deadline expires", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const cleanup = new ReviewScopeError(
      "GIT_CLEANUP_FAILED",
      "Git still runs.",
    );
    try {
      const pending = admitReviewScope(input, {
        authority: {
          listIssueComments: async () => ({ items: [], hasNextPage: false }),
        },
        git: {
          run: async ({ signal }) =>
            new Promise((_, reject) =>
              signal?.addEventListener("abort", () => reject(cleanup), {
                once: true,
              }),
            ),
        },
      });
      const rejected = expect(pending).rejects.toBe(cleanup);
      await vi.advanceTimersByTimeAsync(120_000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("passes one deadline signal to HTTP reads and settles a stalled port", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    let readSignal: AbortSignal | undefined;
    const git = { run: vi.fn() };
    try {
      const admission = admitReviewScope(input, {
        git,
        authority: {
          listIssueComments: async (_pr, _page, signal) => {
            readSignal = signal;
            return new Promise<never>(() => undefined);
          },
        },
      });
      const rejected = expect(admission).rejects.toMatchObject({
        resource: "admissionWallMs",
        limit: 120_000,
      });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(readSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(readSignal?.aborted).toBe(true);
      expect(git.run).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("settles stalled authority reads on caller cancellation", async () => {
    const controller = new AbortController();
    const cause = new Error("stopped");
    const pending = admitReviewScope(input, {
      signal: controller.signal,
      git: { run: vi.fn() },
      authority: {
        listIssueComments: async () => new Promise<never>(() => undefined),
      },
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "REVIEW_ADMISSION_CANCELLED",
    });
    controller.abort(cause);
    await rejected;
  });
  it("passes the authority signal to Git without restarting the deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    let readSignal: AbortSignal | undefined;
    let gitSignal: AbortSignal | undefined;
    try {
      const pending = admitReviewScope(input, {
        authority: {
          listIssueComments: async (_pr, _page, signal) => {
            readSignal = signal;
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            return { items: [], hasNextPage: false };
          },
        },
        git: {
          run: async (request) => {
            gitSignal = request.signal;
            return new Promise((_, reject) =>
              request.signal?.addEventListener(
                "abort",
                () => reject(request.signal?.reason),
                { once: true },
              ),
            );
          },
        },
      });
      const rejected = expect(pending).rejects.toMatchObject({
        resource: "admissionWallMs",
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(gitSignal).toBe(readSignal);
      expect(gitSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(100_000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
