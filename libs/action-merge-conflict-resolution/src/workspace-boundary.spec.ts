// @test-scope ./workspace-boundary.ts
// @test-scope ./git-cli.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NodeGitCli } from "./git-cli.js";
import {
  NodeWorkspaceBoundary,
  createOwnedAgentWorkspace,
  prepareAgentWorkspace,
  validateResolutionWorkspace,
} from "./workspace-boundary.js";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "seqlane-workspace-boundary-"));
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function initRepository(root: string): void {
  git(root, ["init", "--initial-branch=main", "-q"]);
  git(root, ["config", "user.name", "Seqlane Test"]);
  git(root, ["config", "user.email", "test@seqlane.local"]);
  writeFileSync(join(root, "allowed.ts"), "base\n");
  writeFileSync(join(root, "other.ts"), "base\n");
  git(root, ["add", "--", "."]);
  git(root, ["commit", "-qm", "fixture"]);
}

describe("workspace boundary", () => {
  it("clears only an agent workspace owned by the current run", async () => {
    const root = fixtureRoot();
    try {
      const source = join(root, "source");
      const agent = join(root, "agent");
      mkdirSync(source);
      mkdirSync(agent);
      writeFileSync(join(source, "conflict.ts"), "resolved\n");
      writeFileSync(join(agent, "stale.ts"), "remove\n");

      await prepareAgentWorkspace(source, agent, ["conflict.ts"], "run-a");
      assert.equal(
        readFileSync(join(agent, "conflict.ts"), "utf8"),
        "resolved\n",
      );
      assert.equal(false, requireFile(agent, "stale.ts"));

      await assert.rejects(
        () => prepareAgentWorkspace(source, agent, ["conflict.ts"], "run-b"),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "UNSAFE_PATH",
      );
      assert.equal(
        readFileSync(join(agent, "conflict.ts"), "utf8"),
        "resolved\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal, symlinks, binary files, and oversized files", async () => {
    const root = fixtureRoot();
    try {
      const source = join(root, "source");
      const outside = join(root, "outside.txt");
      mkdirSync(source);
      writeFileSync(join(source, "safe.ts"), "safe\n");
      writeFileSync(outside, "outside\n");
      symlinkSync(outside, join(source, "link.ts"));

      await assert.rejects(
        () =>
          prepareAgentWorkspace(
            source,
            createAgentWorkspace(root, "traversal"),
            ["../outside.txt"],
            "run-traversal",
          ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "UNSAFE_PATH",
      );
      await assert.rejects(
        () =>
          prepareAgentWorkspace(
            source,
            createAgentWorkspace(root, "link"),
            ["link.ts"],
            "run-link",
          ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "UNSAFE_PATH",
      );

      writeFileSync(join(source, "binary.ts"), Buffer.from([0, 1, 2]));
      await assert.rejects(
        () =>
          prepareAgentWorkspace(
            source,
            createAgentWorkspace(root, "binary"),
            ["binary.ts"],
            "run-binary",
          ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "UNSUPPORTED_AGENT_FILE",
      );

      writeFileSync(join(source, "large.ts"), Buffer.alloc(512 * 1024 + 1, 65));
      await assert.rejects(
        () =>
          prepareAgentWorkspace(
            source,
            createAgentWorkspace(root, "large"),
            ["large.ts"],
            "run-large",
          ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "WORKSPACE_LIMIT_EXCEEDED",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps lockfiles out of the agent workspace and enforces copy-back allowlists", async () => {
    const root = fixtureRoot();
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      const agent = join(root, "agent");
      mkdirSync(source);
      mkdirSync(target);
      mkdirSync(agent);
      writeFileSync(join(source, "conflict.ts"), "resolved\n");
      writeFileSync(join(target, "conflict.ts"), "conflicted target\n");
      writeFileSync(join(source, "pnpm-lock.yaml"), "lockfile\n");
      writeFileSync(join(source, "other.ts"), "other\n");
      const workspace = new NodeWorkspaceBoundary({
        sourceRoot: source,
        targetRoot: target,
        agentRoot: agent,
        baseRevision: "a".repeat(40),
        headRevision: "b".repeat(40),
        runId: "run-boundary",
      });

      const request = await workspace.prepareAgentWorkspace([
        { path: "conflict.ts", stage: 1 },
        { path: "pnpm-lock.yaml", stage: 1 },
      ]);
      assert.deepEqual(request.paths, ["conflict.ts"]);
      assert.equal(
        readFileSync(join(agent, "conflict.ts"), "utf8"),
        "conflicted target\n",
      );
      assert.equal(readFileIfPresent(join(agent, "pnpm-lock.yaml")), undefined);
      await assert.rejects(
        () => workspace.copyAgentEdits(["other.ts"]),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "UNSAFE_PATH",
      );

      writeFileSync(join(target, "other.ts"), "other target\n");
      await workspace.prepareAgentWorkspace([{ path: "other.ts", stage: 1 }]);
      await expect(
        workspace.copyAgentEdits(["other.ts"]),
      ).resolves.toBeUndefined();
      await expect(
        workspace.copyAgentEdits(["outside.ts"]),
      ).rejects.toMatchObject({
        code: "UNSAFE_PATH",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an agent workspace inside the resolution target", () => {
    const root = fixtureRoot();
    try {
      const target = join(root, "target");
      mkdirSync(target);
      assert.throws(
        () =>
          new NodeWorkspaceBoundary({
            sourceRoot: root,
            targetRoot: target,
            agentRoot: join(target, "agent"),
            baseRevision: "a".repeat(40),
            headRevision: "b".repeat(40),
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "UNSAFE_PATH",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects changed tracked, untracked, and ignored paths outside the allowlist", async () => {
    const root = fixtureRoot();
    try {
      initRepository(root);
      writeFileSync(join(root, "allowed.ts"), "changed\n");
      writeFileSync(join(root, "other.ts"), "changed\n");
      writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(root, "untracked.txt"), "untracked\n");
      writeFileSync(join(root, "ignored.txt"), "ignored\n");

      await assert.rejects(
        () =>
          validateResolutionWorkspace(
            root,
            ["allowed.ts"],
            new NodeGitCli(root),
          ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "UNEXPECTED_TARGET_CHANGE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows integration changes captured before resolver edits", async () => {
    const root = fixtureRoot();
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      const agent = join(root, "agent");
      mkdirSync(source);
      mkdirSync(agent);
      mkdirSync(target);
      initRepository(target);
      writeFileSync(join(target, "other.ts"), "integrated\n");
      git(target, ["add", "--", "other.ts"]);

      const workspace = new NodeWorkspaceBoundary({
        sourceRoot: source,
        targetRoot: target,
        agentRoot: agent,
        baseRevision: "a".repeat(40),
        headRevision: "b".repeat(40),
      });
      await workspace.captureIntegrationBaseline();
      await expect(
        workspace.validateTarget([{ path: "allowed.ts", stage: 1 }]),
      ).resolves.toBeUndefined();

      writeFileSync(join(target, "unauthorized.ts"), "unexpected\n");
      await expect(
        workspace.validateTarget([{ path: "allowed.ts", stage: 1 }]),
      ).rejects.toMatchObject({ code: "UNEXPECTED_TARGET_CHANGE" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds a later lockfile-only conflict to the cumulative allowlist", async () => {
    const root = fixtureRoot();
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      const agent = join(root, "agent");
      mkdirSync(source);
      mkdirSync(agent);
      mkdirSync(target);
      initRepository(target);
      writeFileSync(join(source, "allowed.ts"), "resolved\n");

      const workspace = new NodeWorkspaceBoundary({
        sourceRoot: source,
        targetRoot: target,
        agentRoot: agent,
        baseRevision: "a".repeat(40),
        headRevision: "b".repeat(40),
      });
      await workspace.prepareAgentWorkspace([{ path: "allowed.ts", stage: 1 }]);
      writeFileSync(join(target, "pnpm-lock.yaml"), "lockfile\n");
      await expect(
        workspace.validateTarget([{ path: "pnpm-lock.yaml", stage: 1 }]),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates owned temporary workspaces outside a repository", async () => {
    const root = fixtureRoot();
    try {
      const owned = await createOwnedAgentWorkspace(root);
      assert.equal(owned.path.startsWith(realpathSync(root)), true);
      assert.notEqual(owned.path, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function requireFile(root: string, name: string): boolean {
  try {
    readFileSync(join(root, name));
    return true;
  } catch {
    return false;
  }
}

function createAgentWorkspace(root: string, name: string): string {
  const agent = join(root, `agent-${name}`);
  mkdirSync(agent);
  return agent;
}

function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
