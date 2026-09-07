// @test-scope ./resolution-controller.ts
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
  const commits: unknown[] = [];
  const pushes: unknown[] = [];
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
  const value: ResolveMergeConflictsPorts = {
    github: {
      readPullRequest: async () => metadata(),
      readLiveBaseRevision: async () => ({
        branch: "main",
        revision: revision("c"),
      }),
    },
    git,
    files: {
      prepareAgentWorkspace: async (value) => ({
        paths: value.map(({ path }) => path),
        baseRevision: revision("c"),
        headRevision: revision("b"),
      }),
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
    agent: {
      resolve: async () => {
        agent.push(true);
      },
    },
    summary: {
      write: async (value) => {
        summary.push(value);
      },
    },
    commitAndPush: {
      commit: async () => {
        commits.push(true);
      },
      push: async () => {
        pushes.push(true);
      },
    },
  };
  return { value, summary, agent, lockfiles, commits, pushes };
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

    await expect(
      resolveMergeConflicts(request("rebase"), fake.value),
    ).resolves.toMatchObject({ kind: "resolved", attempts: 2 });
    expect(fake.agent).toHaveLength(4);
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
});
