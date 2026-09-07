// @test-scope ./git-cli.ts
// @test-scope ./git-port.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";

import { NodeGitCli } from "./git-cli.js";

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function commit(root: string, message: string): string {
  git(root, ["add", "--", "."]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "seqlane-git-cli-"));
  git(root, ["init", "--initial-branch=main", "-q"]);
  git(root, ["config", "user.name", "Seqlane Test"]);
  git(root, ["config", "user.email", "test@seqlane.local"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
  return root;
}

function createConflictRepository(
  base: string | Buffer,
  ours: string | Buffer,
  theirs: string | Buffer,
): { readonly root: string; readonly baseRevision: string } {
  const root = createRepository();
  writeFileSync(join(root, "file.txt"), base);
  commit(root, "base");
  git(root, ["checkout", "-qb", "feature"]);
  writeFileSync(join(root, "file.txt"), ours);
  commit(root, "feature");
  git(root, ["checkout", "-q", "main"]);
  writeFileSync(join(root, "file.txt"), theirs);
  const baseRevision = commit(root, "main");
  git(root, ["checkout", "-q", "feature"]);
  return { root, baseRevision };
}

describe("NodeGitCli", () => {
  it("reports a clean merge and aborts its temporary no-commit merge", async () => {
    const { root, baseRevision } = createConflictRepository(
      "base line\nsecond line\nthird line\nfourth line\n",
      "ours line\nsecond line\nthird line\nfourth line\n",
      "base line\nsecond line\nthird line\nmain addition\n",
    );
    try {
      const before = git(root, ["rev-parse", "HEAD"]).trim();
      const result = await new NodeGitCli(root).integrate(
        "merge",
        baseRevision,
      );
      assert.equal(result.kind, "clean");
      if (result.kind === "clean") {
        assert.equal(result.headBefore, before);
        assert.equal(result.headAfter, before);
        assert.equal(result.targetRevision, baseRevision);
      }
      assert.equal(
        readFileSync(join(root, "file.txt"), "utf8"),
        "ours line\nsecond line\nthird line\nfourth line\n",
      );
      assert.deepEqual(await new NodeGitCli(root).readConflictSet(), []);
      assert.equal(git(root, ["status", "--porcelain=v2", "-z"]), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("models a content conflict from the unmerged index", async () => {
    const { root, baseRevision } = createConflictRepository(
      "base\n",
      "ours\n",
      "theirs\n",
    );
    try {
      const result = await new NodeGitCli(root).integrate(
        "merge",
        baseRevision,
      );
      assert.equal(result.kind, "conflicted");
      if (result.kind === "conflicted") {
        assert.deepEqual(result.conflicts, [
          { path: "file.txt", stage: 1 },
          { path: "file.txt", stage: 2 },
          { path: "file.txt", stage: 3 },
        ]);
        assert.equal(result.operation, "merge");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the missing stage for a modify/delete conflict", async () => {
    const root = createRepository();
    try {
      writeFileSync(join(root, "file.txt"), "base\n");
      commit(root, "base");
      git(root, ["checkout", "-qb", "feature"]);
      writeFileSync(join(root, "file.txt"), "modified\n");
      commit(root, "feature");
      git(root, ["checkout", "-q", "main"]);
      unlinkSync(join(root, "file.txt"));
      const baseRevision = commit(root, "main");
      git(root, ["checkout", "-q", "feature"]);

      const result = await new NodeGitCli(root).integrate(
        "merge",
        baseRevision,
      );
      assert.equal(result.kind, "conflicted");
      if (result.kind === "conflicted") {
        assert.deepEqual(result.conflicts, [
          { path: "file.txt", stage: 1 },
          { path: "file.txt", stage: 2 },
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("models a binary conflict without looking for text markers", async () => {
    const { root, baseRevision } = createConflictRepository(
      Buffer.from([0, 1, 2]),
      Buffer.from([0, 1, 3]),
      Buffer.from([0, 1, 4]),
    );
    try {
      const result = await new NodeGitCli(root).integrate(
        "merge",
        baseRevision,
      );
      assert.equal(result.kind, "conflicted");
      if (result.kind === "conflicted") {
        assert.deepEqual(result.conflicts, [
          { path: "file.txt", stage: 1 },
          { path: "file.txt", stage: 2 },
          { path: "file.txt", stage: 3 },
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unrelated worktree changes before integration", async () => {
    const { root, baseRevision } = createConflictRepository(
      "base\n",
      "ours\n",
      "theirs\n",
    );
    try {
      writeFileSync(join(root, "unrelated.txt"), "keep\n");
      const result = await new NodeGitCli(root).integrate(
        "merge",
        baseRevision,
      );
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.equal(result.error.code, "WORKTREE_NOT_CLEAN");
      }
      assert.equal(readFileSync(join(root, "unrelated.txt"), "utf8"), "keep\n");
      assert.equal(
        git(root, ["rev-parse", "HEAD"]).trim(),
        git(root, ["rev-parse", "feature"]).trim(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports rebase conflict detection with the same index source", async () => {
    const { root, baseRevision } = createConflictRepository(
      "base\n",
      "ours\n",
      "theirs\n",
    );
    try {
      const result = await new NodeGitCli(root).integrate(
        "rebase",
        baseRevision,
      );
      assert.equal(result.kind, "conflicted");
      assert.deepEqual(await new NodeGitCli(root).readConflictSet(), [
        { path: "file.txt", stage: 1 },
        { path: "file.txt", stage: 2 },
        { path: "file.txt", stage: 3 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects rebase directories as active operations", async () => {
    const root = createRepository();
    try {
      writeFileSync(join(root, "file.txt"), "content\n");
      commit(root, "initial");
      mkdirSync(join(root, ".git", "rebase-merge"));

      const state = await new NodeGitCli(root).inspectState();

      assert.equal(state.rebaseInProgress, true);
      assert.equal(state.worktreeClean, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages only the original conflict set", async () => {
    const { root, baseRevision } = createConflictRepository(
      "base\n",
      "ours\n",
      "theirs\n",
    );
    try {
      const cli = new NodeGitCli(root);
      const result = await cli.integrate("merge", baseRevision);
      assert.equal(result.kind, "conflicted");
      if (result.kind !== "conflicted") return;
      writeFileSync(join(root, "file.txt"), "resolved\n");
      writeFileSync(join(root, "unrelated.txt"), "do not stage\n");
      await cli.stageConflictSet(result.conflicts);
      assert.deepEqual(await cli.readConflictSet(), []);
      assert.equal(
        git(root, ["diff", "--cached", "--name-only", "-z"]),
        "file.txt\0",
      );
      assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "resolved\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
