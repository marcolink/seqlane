import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  maximumLockfileInputFiles,
  prepareAgentWorkspace,
  prepareLockfileWorkspace,
  validateStagedConflictMarkers,
} from "./resolve-merge-conflicts-workflow.ts";

function createFixture(): string {
  return mkdtempSync(join(tmpdir(), "seqlane-conflict-workflow-"));
}

function writePaths(root: string, name: string, paths: string[]): string {
  const path = join(root, name);
  writeFileSync(path, `${paths.join("\0")}\0`);
  return path;
}

function initializeGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
}

test("does not copy a conflicted lockfile into the regeneration workspace", () => {
  const root = createFixture();
  try {
    initializeGit(root);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      "<<<<<<< HEAD\nlockfileVersion: '9.0'\n=======\nlockfileVersion: '9.1'\n>>>>>>> incoming\n",
    );
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });

    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      "<<<<<<< HEAD\nlockfileVersion: '9.0'\n=======\nlockfileVersion: '9.1'\n>>>>>>> incoming\n",
    );
    const output = join(root, "lockfile-workspace");
    mkdirSync(output);

    prepareLockfileWorkspace(root, output);

    assert.equal(
      readFileSync(join(output, "package.json"), "utf8"),
      '{"name":"fixture"}\n',
    );
    assert.equal(
      readFileSync(join(output, "pnpm-workspace.yaml"), "utf8"),
      "packages: []\n",
    );
    assert.equal(
      readFileSync(join(root, "pnpm-lock.yaml"), "utf8").includes("<<<<<<<"),
      true,
    );
    assert.equal(existsSync(join(output, "pnpm-lock.yaml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepares only bounded regular agent files", () => {
  const root = createFixture();
  try {
    const source = join(root, "source");
    const agent = join(root, "agent");
    mkdirSync(source);
    mkdirSync(agent);
    writeFileSync(join(source, "conflict.ts"), "resolved\n");
    const paths = writePaths(root, "paths", ["conflict.ts"]);

    prepareAgentWorkspace(source, agent, paths);

    assert.equal(
      readFileSync(join(agent, "conflict.ts"), "utf8"),
      "resolved\n",
    );
    assert.equal(maximumLockfileInputFiles, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects conflict markers in staged files", () => {
  const root = createFixture();
  try {
    initializeGit(root);
    writeFileSync(join(root, "conflict.txt"), "<<<<<<< HEAD\nvalue\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: root });
    const paths = writePaths(root, "paths", ["conflict.txt"]);

    assert.throws(
      () => validateStagedConflictMarkers(root, paths),
      /Conflict marker remains in conflict\.txt\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
