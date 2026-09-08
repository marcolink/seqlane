// @test-scope ./resolution-controller.ts
// @test-scope ./conflict-resolution-attempt.ts
// @test-scope ./policy.ts
// @test-scope ./marker-validation.ts

import { describe, expect, it } from "vitest";

import type { ConflictSet, ResolveMergeConflictsPorts } from "./contracts.js";
import { resolveMergeConflicts } from "./resolution-controller.js";

const revision = (letter: string): string => letter.repeat(40);

function request(strategy: "merge" | "rebase" = "merge") {
  return {
    pullRequestNumber: 7,
    strategy,
    sourceDirectory: ".",
    targetDirectory: "resolution-target",
    commit: false,
    push: false,
    maxAttempts: 2,
  };
}

function metadata() {
  return {
    number: 7,
    state: "open" as const,
    baseBranch: "main",
    headBranch: "feature",
    baseRevision: revision("a"),
    headRevision: revision("b"),
    baseRepository: { owner: "seqlane", name: "taskflow" },
    headRepository: { owner: "seqlane", name: "taskflow" },
  };
}

function prepareAgentRequest(conflicts: ConflictSet, prepared: unknown[]) {
  const paths = conflicts.map(({ path }) => path);
  prepared.push(paths);
  return {
    paths,
    baseRevision: revision("c"),
    headRevision: revision("b"),
  };
}

function generatedHandlerRecorder(generated: unknown[]) {
  return async (
    rule: Parameters<ResolveMergeConflictsPorts["generatedFiles"]["run"]>[0],
    conflicts: ConflictSet,
  ) => {
    generated.push({ rule, conflicts });
    return conflicts.map(({ path }) => path);
  };
}

function ports(
  integration: Awaited<
    ReturnType<ResolveMergeConflictsPorts["git"]["integrate"]>
  >,
  conflicts: ConflictSet[] = [],
  inspectStates: Array<{
    readonly mergeInProgress: boolean;
    readonly rebaseInProgress: boolean;
    readonly worktreeClean: boolean;
  }> = [],
  onIntegrate?: () => void,
) {
  const summary: unknown[] = [];
  const agent: unknown[] = [];
  const lockfiles: unknown[] = [];
  const generated: unknown[] = [];
  const prepared: unknown[] = [];
  const baselines: unknown[] = [];
  const commits: unknown[] = [];
  const pushes: unknown[] = [];
  const events: string[] = [];
  let reads = 0;
  let stateReads = 0;
  const git = {
    cwd: "/tmp/target",
    run: async () => ({
      executable: "git",
      args: [],
      cwd: "/tmp/target",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    inspectState: async () =>
      inspectStates[stateReads++] ?? {
        mergeInProgress: false,
        rebaseInProgress: false,
        worktreeClean: true,
      },
    integrate: async () => {
      onIntegrate?.();
      return integration;
    },
    readConflictSet: async () => conflicts[reads++] ?? [],
    stageConflictSet: async () => undefined,
    continueRebase: async () => ({
      executable: "git",
      args: [],
      cwd: "/tmp/target",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    skipRebase: async () => ({
      executable: "git",
      args: [],
      cwd: "/tmp/target",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
  };
  const value = {
    github: {
      readPullRequest: async () => metadata(),
      readLiveBaseRevision: async () => ({
        branch: "main",
        revision: revision("c"),
      }),
    },
    git,
    files: {
      captureIntegrationBaseline: async () => {
        baselines.push(true);
      },
      prepareAgentWorkspace: async (value) =>
        prepareAgentRequest(value, prepared),
      copyAgentEdits: async (paths) => {
        agent.push(paths);
      },
      validateTarget: async () => undefined,
    },
    lockfile: {
      regenerate: async () => {
        lockfiles.push(true);
      },
    },
    generatedFiles: {
      run: generatedHandlerRecorder(generated),
    },
    agent: {
      start: async () => {
        events.push("agent-start");
      },
      resolve: async () => {
        events.push("agent-resolve");
        agent.push(true);
        return {
          summary: "Resolved the requested files.",
          resolvedFiles: ["src/file.ts"],
          decisions: [
            { file: "src/file.ts", decision: "Kept compatible changes." },
          ],
        };
      },
      stop: async () => {
        events.push("agent-stop");
      },
      getAttemptDiagnostics: () => ({ eventCount: 4, truncated: true }),
    },
    summary: {
      write: async (value, report) => {
        summary.push({ result: value, report });
      },
    },
    commitAndPush: {
      commit: async () => {
        commits.push(true);
      },
      beforePush: async () => {
        events.push("before-push");
      },
      push: async () => {
        pushes.push(true);
      },
    },
  } satisfies ResolveMergeConflictsPorts;
  return {
    value,
    summary,
    agent,
    lockfiles,
    generated,
    prepared,
    baselines,
    commits,
    pushes,
    events,
  };
}

describe("resolveMergeConflicts", () => {
  it("returns no-change for a clean merge without agent or push work", async () => {
    const fake = ports({
      kind: "clean",
      operation: "merge",
      headBefore: revision("b"),
      targetRevision: revision("c"),
      headAfter: revision("b"),
    });

    await expect(
      resolveMergeConflicts(request(), fake.value),
    ).resolves.toMatchObject({
      kind: "clean",
      result: "no-change",
      attempts: 0,
      pushed: false,
    });
    expect(fake.agent).toEqual([]);
    expect(fake.lockfiles).toEqual([]);
    expect(fake.commits).toEqual([]);
    expect(fake.pushes).toEqual([]);
    expect(fake.summary).toHaveLength(1);
  });

  it("resolves a lockfile-only conflict without invoking the agent", async () => {
    const fake = ports(
      {
        kind: "conflicted",
        operation: "merge",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        conflicts: [{ path: "pnpm-lock.yaml", stage: 1 }],
      },
      [[{ path: "pnpm-lock.yaml", stage: 1 }], []],
    );

    await expect(
      resolveMergeConflicts(request(), fake.value),
    ).resolves.toMatchObject({
      kind: "resolved",
      attempts: 1,
      pushed: false,
    });
    expect(fake.agent).toEqual([]);
    expect(fake.lockfiles).toEqual([true]);
    expect(fake.baselines).toEqual([true]);
    expect(fake.summary[0]).toMatchObject({
      report: {
        attempts: [{ diagnostics: { eventCount: 0, truncated: false } }],
      },
    });
  });

  it("runs generated handlers mechanically and sends only unmatched conflicts to the agent", async () => {
    const generatedConflict = {
      path: "actions/example/dist/main.js",
      stage: 1 as const,
    };
    const sourceConflict = { path: "src/file.ts", stage: 1 as const };
    const fake = ports(
      {
        kind: "conflicted",
        operation: "merge",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        conflicts: [generatedConflict, sourceConflict],
      },
      [[generatedConflict, sourceConflict], []],
    );

    await expect(
      resolveMergeConflicts(
        {
          ...request(),
          conflictHandlers: {
            version: 1,
            rules: [
              {
                match: "actions/*/dist/*.js",
                outputs: ["actions/*/dist/*.js"],
                handler: { command: ["pnpm", "build"] },
              },
            ],
          },
        },
        fake.value,
      ),
    ).resolves.toMatchObject({ kind: "resolved", attempts: 1 });
    expect(fake.generated).toEqual([
      {
        rule: expect.objectContaining({ match: "actions/*/dist/*.js" }),
        conflicts: [generatedConflict],
      },
    ]);
    expect(fake.prepared).toEqual([["src/file.ts"]]);
    expect(fake.agent[1]).toEqual(["src/file.ts"]);
  });

  it("does not start the agent when a generated handler fails", async () => {
    const generatedConflict = {
      path: "actions/example/dist/main.js",
      stage: 1 as const,
    };
    const sourceConflict = { path: "src/file.ts", stage: 1 as const };
    const fake = ports(
      {
        kind: "conflicted",
        operation: "merge",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        conflicts: [generatedConflict, sourceConflict],
      },
      [[generatedConflict, sourceConflict]],
    );
    fake.value.generatedFiles.run = async () => {
      throw new Error("generated handler failed");
    };

    await expect(
      resolveMergeConflicts(
        {
          ...request(),
          conflictHandlers: {
            version: 1,
            rules: [
              {
                match: "actions/*/dist/*.js",
                outputs: ["actions/*/dist/*.js"],
                handler: { command: ["pnpm", "build"] },
              },
            ],
          },
        },
        fake.value,
      ),
    ).resolves.toMatchObject({
      kind: "error",
      error: { category: "operational", code: "OPERATION_FAILED" },
    });
    expect(fake.events).not.toContain("agent-start");
    expect(fake.prepared).toEqual([]);
    expect(fake.agent).toEqual([]);
    expect(fake.lockfiles).toEqual([]);
  });

  it("returns a typed attempt-limit failure", async () => {
    const conflict = [{ path: "src/file.ts", stage: 1 as const }];
    const fake = ports(
      {
        kind: "conflicted",
        operation: "merge",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        conflicts: conflict,
      },
      [conflict, conflict, conflict],
    );

    await expect(
      resolveMergeConflicts({ ...request(), maxAttempts: 1 }, fake.value),
    ).resolves.toMatchObject({
      kind: "error",
      error: { category: "attempt-limit", code: "ATTEMPT_LIMIT_EXCEEDED" },
    });
    expect(fake.events.filter((event) => event === "agent-stop")).toEqual([
      "agent-stop",
    ]);
  });

  it("rejects a stale integrated head before agent, commit, or push work", async () => {
    const fake = ports({
      kind: "conflicted",
      operation: "merge",
      headBefore: revision("c"),
      targetRevision: revision("d"),
      conflicts: [{ path: "src/file.ts", stage: 1 }],
    });

    await expect(
      resolveMergeConflicts(request(), fake.value),
    ).resolves.toMatchObject({
      kind: "error",
      error: { category: "remote-race", code: "REMOTE_HEAD_CHANGED" },
    });
    expect(fake.agent).toEqual([]);
    expect(fake.lockfiles).toEqual([]);
  });

  it("continues resolving a new conflict after skipping an empty rebase commit", async () => {
    const firstConflict = [{ path: "src/first.ts", stage: 1 as const }];
    const secondConflict = [{ path: "src/second.ts", stage: 1 as const }];
    const fake = ports(
      {
        kind: "conflicted",
        operation: "rebase",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        conflicts: firstConflict,
      },
      [firstConflict, [], [], secondConflict, [], []],
      [
        {
          mergeInProgress: false,
          rebaseInProgress: true,
          worktreeClean: true,
        },
        {
          mergeInProgress: false,
          rebaseInProgress: true,
          worktreeClean: true,
        },
        {
          mergeInProgress: false,
          rebaseInProgress: false,
          worktreeClean: true,
        },
      ],
    );
    let starts = 0;
    let stops = 0;
    let commitReads = 0;
    fake.value.agent.start = async () => {
      starts += 1;
    };
    fake.value.agent.stop = async () => {
      stops += 1;
    };
    fake.value.git.readRebaseConflictCommit = async () => {
      commitReads += 1;
      return {
        sha: revision(commitReads === 1 ? "d" : "e"),
        subject: commitReads === 1 ? "Empty commit" : "Second commit",
      };
    };

    await expect(
      resolveMergeConflicts(request("rebase"), fake.value),
    ).resolves.toMatchObject({ kind: "resolved", attempts: 2 });
    expect(fake.agent).toHaveLength(4);
    expect(fake.baselines).toEqual([true, true]);
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(fake.summary[0]).toMatchObject({
      report: {
        attempts: [
          {
            commit: { oldSha: revision("d") },
            diagnostics: { eventCount: 4, truncated: true },
          },
          {
            commit: {
              oldSha: revision("e"),
            },
            diagnostics: { eventCount: 4, truncated: true },
          },
        ],
      },
    });
    expect(
      (fake.summary[0] as { report: { attempts: Array<{ commit?: unknown }> } })
        .report.attempts[0]?.commit,
    ).not.toHaveProperty("rewrittenSha");
  });

  it("does not report the final rebase head as the rewritten conflict commit", async () => {
    const conflict = [{ path: "src/file.ts", stage: 1 as const }];
    const fake = ports(
      {
        kind: "conflicted",
        operation: "rebase",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        conflicts: conflict,
      },
      [conflict, []],
    );
    fake.value.git.readRebaseConflictCommit = async () => ({
      sha: revision("d"),
      subject: "Resolve parser conflict",
    });

    await expect(
      resolveMergeConflicts(request("rebase"), fake.value),
    ).resolves.toMatchObject({ kind: "resolved", attempts: 1 });

    expect(fake.summary[0]).toMatchObject({
      report: {
        strategy: "rebase",
        attempts: [
          {
            attempt: 1,
            commit: {
              oldSha: revision("d"),
              subject: "Resolve parser conflict",
            },
          },
        ],
      },
    });
    expect(
      (fake.summary[0] as { report: { attempts: Array<{ commit?: unknown }> } })
        .report.attempts[0]?.commit,
    ).not.toHaveProperty("rewrittenSha");
  });

  it("rejects merge push without commit before integration", async () => {
    let integrated = false;
    const fake = ports(
      {
        kind: "clean",
        operation: "merge",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        headAfter: revision("b"),
      },
      [],
      [],
      () => {
        integrated = true;
      },
    );

    await expect(
      resolveMergeConflicts(
        { ...request(), push: true, commit: false },
        fake.value,
      ),
    ).resolves.toMatchObject({
      kind: "error",
      error: { category: "input-validation", code: "INVALID_REQUEST" },
    });
    expect(integrated).toBe(false);
  });

  it("stops the agent before configuring push authentication", async () => {
    const conflict = [{ path: "src/file.ts", stage: 1 as const }];
    const fake = ports(
      {
        kind: "conflicted",
        operation: "merge",
        headBefore: revision("b"),
        targetRevision: revision("c"),
        conflicts: conflict,
      },
      [conflict, []],
    );

    await expect(
      resolveMergeConflicts(
        { ...request(), commit: true, push: true },
        fake.value,
      ),
    ).resolves.toMatchObject({ kind: "resolved", pushed: true });
    expect(fake.events.indexOf("agent-stop")).toBeLessThan(
      fake.events.indexOf("before-push"),
    );
  });
});
