// @test-scope ./prepare-release.mjs
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { releaseClientConfig } from "./prepare-release.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const prepareReleasePath = join(
  workspaceRoot,
  "scripts",
  "prepare-release.mjs",
);
const nxConfig = JSON.parse(
  readFileSync(new URL("../nx.json", import.meta.url), "utf8"),
);
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const publishWorkflow = readFileSync(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const publishCommand =
  nxConfig.targetDefaults["nx-release-publish"].options.command;

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function runPublishCommand(nxDryRun, published = false) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-publish-target-"));
  const binDirectory = join(temporaryRoot, "bin");
  const callsFile = join(temporaryRoot, "calls.log");

  try {
    mkdirSync(binDirectory);
    mkdirSync(join(temporaryRoot, "package"));
    writeFileSync(
      join(temporaryRoot, "package", "package.json"),
      JSON.stringify({ name: "@seqlane/fixture", version: "0.0.1" }),
    );
    mkdirSync(join(temporaryRoot, ".nx", "release-packages"), {
      recursive: true,
    });

    for (const name of ["pnpm", "npm"]) {
      executable(
        join(binDirectory, name),
        `printf '%s' '${name}' >> '${callsFile}'\nprintf ' %s' "$@" >> '${callsFile}'\nprintf '\\n' >> '${callsFile}'\n${name === "npm" ? `if [ "$1" = "view" ]; then exit ${published ? 0 : 1}; fi` : ""}`,
      );
    }

    const environment = {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
    };
    if (nxDryRun === undefined) delete environment.NX_DRY_RUN;
    else environment.NX_DRY_RUN = nxDryRun;

    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        publishCommand
          .replaceAll("{projectRoot}", "package")
          .replaceAll("{projectName}", "fixture"),
      ],
      { cwd: temporaryRoot, encoding: "utf8", env: environment },
    );
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n")
      : [];
    return { calls, result };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeNxAdapter(path) {
  writeFileSync(
    path,
    `import { appendFileSync, writeFileSync } from "node:fs";\nconst record = (value) => appendFileSync(process.env.CALLS_FILE, value + "\\n");\nexport async function calculateVersion({ firstRelease }) {\n  record("calculate " + firstRelease);\n  return process.env.EXPECTED_VERSION;\n}\nexport async function restoreVersion(version) {\n  record("restore " + version);\n}\nexport async function generateChangelog({ firstRelease, from, to, version }) {\n  record(["changelog", firstRelease, from ?? "none", to, version].join(" "));\n  writeFileSync("CHANGELOG.md", "# Release notes\\n");\n}\n`,
  );
}

function runRelease({
  advanceMain = false,
  baselineTag = true,
  existingTag,
  expectedVersion = "0.0.1",
}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-release-"));
  const remote = join(temporaryRoot, "remote.git");
  const repository = join(temporaryRoot, "repository");
  const binDirectory = join(temporaryRoot, "bin");
  const callsFile = join(temporaryRoot, "calls.log");
  const outputFile = join(temporaryRoot, "release-result.json");
  const adapterFile = join(temporaryRoot, "nx-adapter.mjs");
  const releaseState = join(temporaryRoot, "release-created");

  try {
    mkdirSync(repository);
    mkdirSync(binDirectory);
    runGit(temporaryRoot, ["init", "--bare", remote]);
    runGit(repository, ["init", "--initial-branch=main"]);
    runGit(repository, ["config", "user.name", "Release Test"]);
    runGit(repository, ["config", "user.email", "release@example.com"]);
    writeFileSync(join(repository, "fixture.txt"), "baseline\n");
    runGit(repository, ["add", "fixture.txt"]);
    runGit(repository, ["commit", "-m", "chore: baseline"]);
    if (baselineTag) runGit(repository, ["tag", "v0.0.0"]);
    writeFileSync(join(repository, "fixture.txt"), "release\n");
    runGit(repository, ["commit", "-am", "fix: release"]);
    const releaseSha = runGit(repository, ["rev-parse", "HEAD"]);
    if (existingTag) runGit(repository, ["tag", existingTag]);
    runGit(repository, ["remote", "add", "origin", remote]);
    runGit(repository, ["push", "origin", "main", "--tags"]);

    if (advanceMain) {
      writeFileSync(join(repository, "fixture.txt"), "advanced\n");
      runGit(repository, ["commit", "-am", "fix: advance main"]);
      runGit(repository, ["push", "origin", "main"]);
      runGit(repository, ["checkout", "--detach", releaseSha]);
    }

    executable(
      join(binDirectory, "pnpm"),
      `printf 'pnpm %s\\n' "$*" >> '${callsFile}'\nupstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)" || exit 1\nprintf 'upstream %s\\n' "$upstream" >> '${callsFile}'\n[ "$upstream" = "origin/main" ] || exit 1\nif [ "$*" = "exec nx release --skip-publish --first-release" ]; then\n  git tag v0.0.1\n  git push origin v0.0.1 >/dev/null\n  : > '${releaseState}'\nfi`,
    );
    executable(
      join(binDirectory, "gh"),
      `printf 'gh %s\\n' "$*" >> '${callsFile}'\nif [ "$1" = "release" ] && [ "$2" = "view" ]; then\n  [ -f '${releaseState}' ]\nelif [ "$1" = "release" ] && { [ "$2" = "create" ] || [ "$2" = "edit" ]; }; then\n  : > '${releaseState}'\nfi`,
    );
    writeNxAdapter(adapterFile);

    const result = spawnSync(
      process.execPath,
      [prepareReleasePath, "--output", outputFile],
      {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          CALLS_FILE: callsFile,
          EXPECTED_VERSION: expectedVersion,
          GITHUB_SHA: releaseSha,
          PATH: `${binDirectory}:${process.env.PATH}`,
          SEQLANE_RELEASE_NX_ADAPTER: adapterFile,
        },
      },
    );

    return {
      calls: existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "",
      output: existsSync(outputFile)
        ? JSON.parse(readFileSync(outputFile, "utf8"))
        : undefined,
      result,
      tags: runGit(repository, ["tag", "--list"]),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("publish target fails before registry or pack without dry-run intent", () => {
  const { calls, result } = runPublishCommand(undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NX_DRY_RUN must be explicitly set/);
  assert.deepEqual(calls, []);
});

test("publish target packs and forwards explicit dry-run intent", () => {
  const { calls, result } = runPublishCommand("true");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^pnpm .* pack /);
  assert.match(calls[1], /^npm publish .* --dry-run=true$/);
});

test("publish target skips an existing version before packing", () => {
  const { calls, result } = runPublishCommand("false", true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, ["npm view @seqlane/fixture@0.0.1 version --json"]);
});

test("publish target checks before packing and publishing a missing version", () => {
  const { calls, result } = runPublishCommand("false", false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "npm view @seqlane/fixture@0.0.1 version --json");
  assert.match(calls[1], /^pnpm .* pack /);
  assert.match(calls[2], /^npm publish .* --dry-run=false$/);
});

test("CI delegates release state after its quality gate", () => {
  assert.match(
    ciWorkflow,
    /publish:\n    name: Publish npm packages\n    needs: quality/,
  );
  assert.match(ciWorkflow, /uses: \.\/\.github\/workflows\/publish\.yml/);
  assert.doesNotMatch(ciWorkflow, /secrets: inherit/);
  assert.match(publishWorkflow, /workflow_call/);
  assert.match(publishWorkflow, /publish:\n    needs: build/);
  assert.match(
    publishWorkflow,
    /name: npm-release-builds-\$\{\{ github\.sha \}\}/,
  );
  assert.match(publishWorkflow, /node scripts\/prepare-release\.mjs --output/);
  assert.match(publishWorkflow, /GITHUB_OUTPUT/);
  assert.match(publishWorkflow, /GITHUB_STEP_SUMMARY/);
  assert.match(publishWorkflow, /GIT_CONFIG_KEY_0/);
  assert.match(publishWorkflow, /id-token: write/);
  assert.doesNotMatch(
    publishWorkflow,
    /NODE_AUTH_TOKEN|secrets\.NPM_TOKEN|registry-url:/,
  );
  assert.doesNotMatch(publishWorkflow, /secrets\.RELEASE_GITHUB_TOKEN/);
  assert.equal(nxConfig.release.git.commit, false);
  assert.equal(nxConfig.release.git.tag, true);
  assert.equal(nxConfig.release.git.push, true);
});

test("release client disables Git writes for recovery operations", () => {
  const config = releaseClientConfig(nxConfig);
  assert.equal(config.git, undefined);
  assert.deepEqual(config.version.git, { commit: false, tag: false });
  assert.deepEqual(config.changelog.git, {
    commit: false,
    push: false,
    tag: false,
  });
  assert.equal(config.changelog.workspaceChangelog.createRelease, false);
});

test("new state creates the first release", () => {
  const execution = runRelease({});
  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.deepEqual(execution.output, {
    firstRelease: true,
    releaseTag: "v0.0.1",
    released: true,
    state: "new",
  });
  assert.match(
    execution.calls,
    /pnpm exec nx release --skip-publish --first-release/,
  );
  assert.match(execution.calls, /upstream origin\/main/);
});

test("recover state supports the first release without a prior tag after main advances", () => {
  const execution = runRelease({
    advanceMain: true,
    baselineTag: false,
    existingTag: "v0.0.1",
  });
  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.deepEqual(execution.output, {
    firstRelease: true,
    releaseTag: "v0.0.1",
    released: true,
    state: "recover",
  });
  assert.match(execution.calls, /calculate true/);
  assert.match(execution.calls, /restore 0\.0\.1/);
  assert.match(execution.calls, /changelog true none [0-9a-f]{40} 0\.0\.1/);
  assert.match(execution.calls, /gh release create v0\.0\.1 --verify-tag/);
});

test("recover state rejects a tag that does not match the Nx version", () => {
  const execution = runRelease({
    existingTag: "v0.0.2",
    expectedVersion: "0.0.1",
  });
  assert.notEqual(execution.result.status, 0);
  assert.match(execution.result.stderr, /does not match Nx version 0\.0\.1/);
  assert.match(execution.tags, /v0\.0\.2/);
  assert.doesNotMatch(execution.calls, /restore|changelog|gh release/);
});

test("recover state rejects a non-strict SemVer release tag", () => {
  const execution = runRelease({ existingTag: "v01.0.1" });
  assert.notEqual(execution.result.status, 0);
  assert.match(execution.result.stderr, /Invalid release tag: v01\.0\.1/);
  assert.equal(execution.output, undefined);
});
