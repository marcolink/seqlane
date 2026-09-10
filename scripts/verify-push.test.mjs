import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actionBundleDriftArgs,
  bundleVerificationIssues,
  discoverActionBundles,
} from "./action-bundle-verifier.mjs";

import {
  assertCleanWorktree,
  cacheDirectories,
  cleanGitEnvironment,
  nxAffectedArgs,
  parsePrePushInput,
  selectOutgoingRevision,
  useWorktreeNxDirectories,
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

test("runs the uncached bundle-drift target for every discovered Action", () => {
  const root = mkdtempSync(join(tmpdir(), "seqlane-bundle-test-"));
  try {
    mkdirSync(join(root, "actions/example"), { recursive: true });
    mkdirSync(join(root, "actions/another"), { recursive: true });
    writeFileSync(
      join(root, "actions/example/project.json"),
      JSON.stringify({
        name: "action-example",
        targets: {
          build: {
            options: {
              outputPath: "actions/example/dist",
              outputFileName: "main.js",
            },
            outputs: ["{projectRoot}/dist"],
          },
          "bundle-drift": {},
        },
      }),
    );
    writeFileSync(
      join(root, "actions/another/project.json"),
      JSON.stringify({
        name: "action-another",
        targets: {
          build: {
            options: {
              outputPath: "actions/another/dist",
              outputFileName: "main.js",
            },
            outputs: ["{projectRoot}/dist"],
          },
          "bundle-drift": {},
        },
      }),
    );

    assert.deepEqual(actionBundleDriftArgs(root), [
      "exec",
      "nx",
      "run-many",
      "-t",
      "bundle-drift",
      "--projects=action-another,action-example",
      "--output-style=static",
      "--skip-nx-cache",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers Action build targets and bundle outputs from project metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "seqlane-bundle-test-"));
  try {
    mkdirSync(join(root, "actions/example"), { recursive: true });
    writeFileSync(
      join(root, "actions/example/project.json"),
      JSON.stringify({
        name: "action-example",
        targets: {
          build: {
            options: {
              outputPath: "actions/example/dist",
              outputFileName: "main.js",
            },
            outputs: ["{projectRoot}/dist"],
          },
          "bundle-drift": {},
          "build-post": {
            options: {
              outputPath: "actions/example/dist",
              outputFileName: "post.js",
            },
            outputs: ["{projectRoot}/dist"],
          },
        },
      }),
    );

    assert.deepEqual(discoverActionBundles(root), [
      {
        name: "action-example",
        projectRoot: "actions/example",
        targets: {
          build: {
            outputPaths: ["actions/example/dist/main.js"],
          },
          "build-post": {
            outputPaths: ["actions/example/dist/post.js"],
          },
        },
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects Action projects without a bundle-drift target", () => {
  const root = mkdtempSync(join(tmpdir(), "seqlane-bundle-test-"));
  try {
    mkdirSync(join(root, "actions/example"), { recursive: true });
    writeFileSync(
      join(root, "actions/example/project.json"),
      JSON.stringify({
        name: "action-example",
        targets: {
          build: {
            options: {
              outputPath: "actions/example/dist",
              outputFileName: "main.js",
            },
            outputs: ["{projectRoot}/dist"],
          },
        },
      }),
    );

    assert.throws(
      () => discoverActionBundles(root),
      /Action project actions\/example has a build target but no bundle-drift target/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports missing, untracked, extra, and changed bundle files", () => {
  assert.deepEqual(
    bundleVerificationIssues({
      expectedPaths: ["actions/example/dist/main.js"],
      existingPaths: [
        "actions/example/dist/extra.js",
        "actions/example/dist/main.js",
      ],
      trackedPaths: ["actions/example/dist/main.js"],
      changedPaths: ["actions/example/dist/main.js"],
    }),
    {
      missing: [],
      untracked: ["actions/example/dist/extra.js"],
      extra: ["actions/example/dist/extra.js"],
      changed: ["actions/example/dist/main.js"],
    },
  );

  assert.deepEqual(
    bundleVerificationIssues({
      expectedPaths: ["actions/example/dist/main.js"],
      existingPaths: [],
      trackedPaths: ["actions/example/dist/main.js"],
      changedPaths: [],
    }).missing,
    ["actions/example/dist/main.js"],
  );
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

test("forces Nx to use cache paths owned by the current worktree", () => {
  assert.deepEqual(
    useWorktreeNxDirectories(
      {
        NX_WORKSPACE_DATA_DIRECTORY: "/main-checkout/.nx/workspace-data",
        NX_CACHE_DIRECTORY: "/main-checkout/.nx/cache",
        PATH: "/usr/bin",
      },
      {
        workspaceData: "/tmp/seqlane-nx/workspace-data",
        cache: "/tmp/seqlane-nx/cache",
      },
    ),
    {
      NX_WORKSPACE_DATA_DIRECTORY: "/tmp/seqlane-nx/workspace-data",
      NX_CACHE_DIRECTORY: "/tmp/seqlane-nx/cache",
      PATH: "/usr/bin",
    },
  );
});
