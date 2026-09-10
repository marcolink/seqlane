import assert from "node:assert/strict";
import test from "node:test";

import {
  actionBundleInputsChanged,
  actionBundlePostBuildArgs,
  assertCleanWorktree,
  cacheDirectories,
  cleanGitEnvironment,
  nxAffectedArgs,
  parsePrePushInput,
  selectOutgoingRevision,
} from "./verify-push.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

test("parses one pre-push ref update", () => {
  assert.deepEqual(
    parsePrePushInput(
      `refs/heads/feature ${sha} refs/heads/feature ${otherSha}\n`,
    ),
    [
      {
        localRef: "refs/heads/feature",
        localSha: sha,
        remoteRef: "refs/heads/feature",
        remoteSha: otherSha,
      },
    ],
  );
});

test("selects the outgoing revision only when it matches the current HEAD", () => {
  assert.deepEqual(
    selectOutgoingRevision(
      parsePrePushInput(
        `refs/heads/feature ${sha} refs/heads/feature ${otherSha}\n`,
      ),
      sha,
    ),
    { kind: "verify", revision: sha },
  );
  assert.throws(
    () =>
      selectOutgoingRevision(
        parsePrePushInput(
          `refs/heads/feature ${sha} refs/heads/feature ${otherSha}\n`,
        ),
        otherSha,
      ),
    /does not match current HEAD/,
  );
});

test("skips ref deletions and rejects multiple updates", () => {
  assert.deepEqual(selectOutgoingRevision([], sha), {
    kind: "verify",
    revision: sha,
  });
  assert.deepEqual(
    selectOutgoingRevision(
      parsePrePushInput(
        `refs/heads/feature ${"0".repeat(40)} refs/heads/feature ${otherSha}\n`,
      ),
      sha,
    ),
    { kind: "skip" },
  );
  assert.throws(
    () =>
      selectOutgoingRevision(
        parsePrePushInput(
          `refs/heads/a ${sha} refs/heads/a ${otherSha}\nrefs/heads/b ${otherSha} refs/heads/b ${sha}\n`,
        ),
        sha,
      ),
    /one branch update/,
  );
  assert.throws(
    () =>
      selectOutgoingRevision(
        parsePrePushInput(
          `refs/heads/feature ${sha} refs/heads/feature ${otherSha}\nrefs/heads/old ${"0".repeat(40)} refs/heads/old ${otherSha}\n`,
        ),
        sha,
      ),
    /one branch update/,
  );
});

test("applies the dirty-worktree guard to deletion pushes", () => {
  const selection = selectOutgoingRevision(
    parsePrePushInput(
      `refs/heads/feature ${"0".repeat(40)} refs/heads/feature ${otherSha}\n`,
    ),
    sha,
  );

  assert.equal(selection.kind, "skip");
  assert.throws(() => assertCleanWorktree(" M README.md"), /clean worktree/);
});

test("builds explicit Nx affected arguments", () => {
  assert.deepEqual(nxAffectedArgs("test", "base", "head"), [
    "exec",
    "nx",
    "affected",
    "-t",
    "test",
    "--output-style=static",
    "--base=base",
    "--head=head",
  ]);
});

test("derives stable, separate cache paths for each worktree", () => {
  const first = cacheDirectories("/tmp/worktree-a", "/tmp");
  const second = cacheDirectories("/tmp/worktree-b", "/tmp");

  assert.notEqual(first.workspaceData, second.workspaceData);
  assert.notEqual(first.cache, second.cache);
  assert.match(first.workspaceData, /seqlane-nx-/);
});

test("detects Action entrypoint and compiler configuration bundle inputs", () => {
  assert.equal(
    actionBundleInputsChanged(["actions/code-review/src/post.ts"]),
    true,
  );
  assert.equal(actionBundleInputsChanged(["tsconfig.base.json"]), true);
  assert.equal(actionBundleInputsChanged(["README.md"]), false);
});

test("builds the explicit Action post-entrypoint command", () => {
  assert.deepEqual(actionBundlePostBuildArgs(), [
    "exec",
    "nx",
    "run",
    "action-code-review:build-post",
    "--output-style=static",
  ]);
});

test("removes Git hook environment variables from child-check environments", () => {
  assert.deepEqual(
    cleanGitEnvironment(
      {
        GIT_DIR: ".git",
        GIT_WORK_TREE: ".",
        PATH: "/usr/bin",
      },
      ["GIT_DIR", "GIT_WORK_TREE"],
    ),
    { PATH: "/usr/bin" },
  );
});
