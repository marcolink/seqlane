import { describe, expect, it, vi } from "vitest";
import {
  ReviewGitBudget,
  type BoundedReviewGitPort,
} from "./review-git-budget.js";
import { REVIEW_GIT_LIMITS } from "./review-scope-contracts.js";

function result() {
  return {
    exitCode: 0,
    stdout: Buffer.from("commit\n"),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    usage: { wallMs: 1, cpuMs: 1, peakMemoryBytes: 1, transferBytes: 0 },
  };
}

describe("review Git budgets", () => {
  it("rejects a non-finite or backwards admission clock", async () => {
    for (const clock of [() => Number.NaN, () => -1]) {
      const run = vi.fn(async () => result());
      await expect(
        new ReviewGitBudget({ run }, 0, clock).run(["diff"]),
      ).rejects.toMatchObject({ code: "INVALID_ADMISSION_TIME" });
      expect(run).not.toHaveBeenCalled();
    }
  });
  it("shares decreasing capacity across commands", async () => {
    const run = vi.fn<BoundedReviewGitPort["run"]>(async () => result());
    const budget = new ReviewGitBudget({ run }, 0, () => 0);
    await budget.run(["cat-file", "-t", "a".repeat(40)]);
    await budget.run(["cat-file", "-t", "b".repeat(40)]);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      limits: { cpuMs: 59_999, outputBytes: 2_047_993 },
    });
  });

  it.each([
    ["wallMs", 30_000, "commandWallMs"],
    ["cpuMs", 60_000, "commandCpuMs"],
    ["peakMemoryBytes", 256 * 1024 * 1024, "peakMemoryBytes"],
  ])(
    "accepts equality and refuses one-over %s",
    async (resource, maximum, expectedResource) => {
      for (const delta of [0, 1]) {
        const value = result();
        const usage = { ...value.usage, [resource]: maximum + delta };
        const budget = new ReviewGitBudget(
          { run: async () => ({ ...value, usage }) },
          0,
          () => 0,
        );
        const promise = budget.run(["diff"]);
        if (delta === 0) await expect(promise).resolves.toBeDefined();
        else
          await expect(promise).rejects.toMatchObject({
            resource: expectedResource,
            observed: maximum + 1,
          });
      }
    },
  );

  it("caps cumulative wall and CPU without refreshing between commands", async () => {
    const value = result();
    const run = vi.fn(async () => ({
      ...value,
      usage: { ...value.usage, wallMs: 30_000, cpuMs: 20_000 },
    }));
    const budget = new ReviewGitBudget({ run }, 0, () => 0);
    for (let index = 0; index < 3; index++) await budget.run(["diff"]);
    await expect(budget.run(["diff"])).rejects.toMatchObject({
      code: "REVIEW_SCOPE_BUDGET_EXHAUSTED",
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("counts stderr in the byte budget and passes remaining capacity to the port", async () => {
    const value = {
      ...result(),
      stdout: Buffer.alloc(REVIEW_GIT_LIMITS.outputBytes),
      stderr: Buffer.alloc(0),
    };
    await expect(
      new ReviewGitBudget({ run: async () => value }, 0, () => 0).run(["diff"]),
    ).resolves.toBeDefined();
    await expect(
      new ReviewGitBudget(
        { run: async () => ({ ...value, stderr: Buffer.alloc(1) }) },
        0,
        () => 0,
      ).run(["diff"]),
    ).rejects.toMatchObject({ resource: "outputBytes" });
  });

  it("rejects missing usage and truncated output", async () => {
    for (const value of [
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      { ...result(), stdoutTruncated: true },
      { ...result(), usage: { wallMs: 1 } },
    ]) {
      await expect(
        new ReviewGitBudget({ run: async () => value }, 0, () => 0).run([
          "diff",
        ]),
      ).rejects.toThrow();
    }
  });

  it("caps exact-checkpoint transfer and charges fetch to the shared budget", async () => {
    const fetchExactCommit = vi.fn<
      NonNullable<BoundedReviewGitPort["fetchExactCommit"]>
    >(async () => ({
      ...result(),
      usage: {
        ...result().usage,
        transferBytes: REVIEW_GIT_LIMITS.fetchBytes + 1,
      },
    }));
    const budget = new ReviewGitBudget(
      { run: async () => result(), fetchExactCommit },
      0,
      () => 0,
    );
    await expect(budget.fetchExactCommit("a".repeat(40))).rejects.toMatchObject(
      {
        resource: "transferBytes",
      },
    );
    expect(fetchExactCommit.mock.calls[0]?.[1]).toMatchObject({
      limits: { wallMs: 30_000, transferBytes: 16 * 1024 * 1024 },
    });
  });

  it("routes commands and fetches separately while sharing remaining capacity", async () => {
    const run = vi.fn<BoundedReviewGitPort["run"]>(async () => result());
    const fetchExactCommit = vi.fn<
      NonNullable<BoundedReviewGitPort["fetchExactCommit"]>
    >(async () => result());
    const budget = new ReviewGitBudget({ run, fetchExactCommit }, 0, () => 0);
    const revision = "a".repeat(40);
    await budget.run(["status"]);
    await budget.fetchExactCommit(revision);
    await budget.run(["diff"]);
    expect(run.mock.calls.map(([request]) => request.argv)).toEqual([
      ["--no-replace-objects", "status"],
      ["--no-replace-objects", "diff"],
    ]);
    expect(fetchExactCommit).toHaveBeenCalledTimes(1);
    expect(fetchExactCommit.mock.calls[0]).toMatchObject([
      revision,
      {
        limits: {
          cpuMs: 59_999,
          outputBytes: 2_047_993,
          transferBytes: 16 * 1024 * 1024,
        },
      },
    ]);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      limits: { cpuMs: 59_998, outputBytes: 2_047_986, transferBytes: 0 },
    });
  });

  it("rejects unavailable fetch capability without running a Git command", async () => {
    const run = vi.fn(async () => result());
    const budget = new ReviewGitBudget({ run }, 0, () => 0);
    await expect(budget.fetchExactCommit("a".repeat(40))).rejects.toMatchObject(
      {
        code: "CHECKPOINT_UNAVAILABLE",
      },
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an expired admission before invoking Git", async () => {
    const run = vi.fn(async () => result());
    await expect(
      new ReviewGitBudget({ run }, 0, () => 120_001).run(["diff"]),
    ).rejects.toMatchObject({ resource: "admissionWallMs" });
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates cancellation before or during a host operation", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort("stopped");
      return result();
    });
    const budget = new ReviewGitBudget({ run }, 0, () => 0, controller.signal);
    await expect(budget.run(["diff"])).rejects.toMatchObject({
      code: "REVIEW_SCOPE_CANCELLED",
      cause: "stopped",
    });
    await expect(budget.run(["diff"])).rejects.toMatchObject({
      code: "REVIEW_SCOPE_CANCELLED",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
