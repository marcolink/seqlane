// @test-scope ./prepare-release.mjs ./check-release-publication.mjs ./release-channel.mjs
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

function preparePublishFixture(root, version) {
  mkdirSync(join(root, "scripts"));
  for (const name of ["check-release-publication.mjs", "release-channel.mjs"])
    copyFileSync(
      join(workspaceRoot, "scripts", name),
      join(root, "scripts", name),
    );
  symlinkSync(join(workspaceRoot, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "package"));
  writeFileSync(
    join(root, "package", "package.json"),
    JSON.stringify({ name: "@seqlane/fixture", version }),
  );
  mkdirSync(join(root, ".nx", "release-packages"), {
    recursive: true,
  });
}

function registryStub({ branch, version, registryError, current, published }) {
  const tags = JSON.stringify({
    [branch === "next" ? "next" : "latest"]: current ?? version,
  });
  const result = JSON.stringify(
    published ? version : { error: { code: registryError ?? "E404" } },
  );
  return `if [ "$1" = "view" ]; then
if [ "$3" = "dist-tags" ]; then printf '%s\\n' '${tags}'; exit 0; fi
printf '%s\\n' '${result}'; exit ${published ? 0 : 1}; fi`;
}

function runPublishCommand(
  nxDryRun,
  published = false,
  { branch = "main", version = "0.0.1", registryError, current } = {},
) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-publish-target-"));
  const binDirectory = join(temporaryRoot, "bin");
  const callsFile = join(temporaryRoot, "calls.log");

  try {
    mkdirSync(binDirectory);
    preparePublishFixture(temporaryRoot, version);

    for (const name of ["pnpm", "npm"]) {
      executable(
        join(binDirectory, name),
        `printf '%s' '${name}' >> '${callsFile}'\nprintf ' %s' "$@" >> '${callsFile}'\nprintf '\\n' >> '${callsFile}'\n${
          name === "npm"
            ? registryStub({
                branch,
                version,
                registryError,
                current,
                published,
              })
            : ""
        }`,
      );
    }

    const environment = {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      SEQLANE_RELEASE_BRANCH: branch,
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
    `
import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const record = (value) => appendFileSync(process.env.CALLS_FILE, value + "\\n");
export async function calculateVersion({ firstRelease }) {
  record("calculate " + firstRelease);
  return process.env.EXPECTED_VERSION === "none" ? null : process.env.EXPECTED_VERSION;
}
export async function restoreVersion(version) { record("restore " + version); }
export async function generateChangelog({ firstRelease, from, to, version }) {
  record(["changelog", firstRelease, from ?? "none", to, version].join(" "));
  writeFileSync("CHANGELOG.md", "# Release notes\\n");
}
export async function createRelease(options) {
  record("create " + options.version);
  await generateChangelog(options);
  const tag = "v" + options.version;
  execFileSync("git", ["tag", tag]);
  execFileSync("git", ["push", "origin", tag]);
}
`,
  );
}

function runRelease({
  advanceMain = false,
  branch = "main",
  baselineVersion = "0.0.0",
  extraTag,
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
    if (baselineTag) runGit(repository, ["tag", `v${baselineVersion}`]);
    if (branch === "next") runGit(repository, ["switch", "-c", "next"]);
    writeFileSync(join(repository, "fixture.txt"), "release\n");
    runGit(repository, ["commit", "-am", "fix: release"]);
    const releaseSha = runGit(repository, ["rev-parse", "HEAD"]);
    if (existingTag) runGit(repository, ["tag", existingTag]);
    if (extraTag) runGit(repository, ["tag", extraTag]);
    runGit(repository, ["remote", "add", "origin", remote]);
    runGit(repository, [
      "push",
      "origin",
      ...new Set(["main", branch]),
      "--tags",
    ]);

    if (advanceMain) {
      writeFileSync(join(repository, "fixture.txt"), "advanced\n");
      runGit(repository, ["commit", "-am", "fix: advance main"]);
      runGit(repository, ["push", "origin", branch]);
      runGit(repository, ["checkout", "--detach", releaseSha]);
    }

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
          GITHUB_REF_NAME: branch,
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
  assert.match(result.stderr, /Invalid option/);
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
  assert.equal(calls.length, 4);
  assert.equal(calls[0], "npm view @seqlane/fixture@0.0.1 version --json");
  assert.equal(calls[1], "npm view @seqlane/fixture dist-tags --json");
  assert.match(calls[2], /^pnpm .* pack /);
  assert.match(calls[3], /^npm publish .* --tag=latest --dry-run=false$/);
});

test("beta archives use next and stable archives cannot enter the beta channel", () => {
  const beta = runPublishCommand("true", false, {
    branch: "next",
    version: "0.3.0-beta.0",
  });
  assert.equal(beta.result.status, 0, beta.result.stderr);
  assert.match(beta.calls.at(-1), /--tag=next --dry-run=true$/);
  const invalid = runPublishCommand("false", false, { branch: "next" });
  assert.notEqual(invalid.result.status, 0);
  assert.deepEqual(invalid.calls, []);
});

test("registry authentication errors and backward tag moves stop before packing", () => {
  const failed = runPublishCommand("false", false, { registryError: "E401" });
  assert.notEqual(failed.result.status, 0);
  assert.equal(failed.calls.length, 1);
  const stale = runPublishCommand("false", false, {
    branch: "next",
    version: "0.3.0-beta.1",
    current: "0.3.0-beta.2",
  });
  assert.notEqual(stale.result.status, 0);
  assert.match(stale.result.stderr, /Refusing to move/);
  assert.equal(stale.calls.length, 2);
});

test("CI delegates release state after its quality gate", () => {
  assert.match(
    ciWorkflow,
    /publish:\n {4}name: Publish npm packages\n {4}needs: quality/,
  );
  assert.match(ciWorkflow, /uses: \.\/\.github\/workflows\/publish\.yml/);
  assert.doesNotMatch(ciWorkflow, /secrets: inherit/);
  assert.match(publishWorkflow, /workflow_call/);
  assert.match(publishWorkflow, /publish:\n {4}needs: build/);
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
    branch: "main",
    distTag: "latest",
  });
  assert.match(execution.calls, /create 0\.0\.1/);
  assert.match(execution.calls, /--prerelease=false --latest=true/);
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
    branch: "main",
    distTag: "latest",
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

test("beta release and recovery retain branch and prerelease identity", () => {
  const created = runRelease({
    branch: "next",
    baselineVersion: "0.2.1",
    expectedVersion: "0.3.0-beta.0",
  });
  assert.equal(created.result.status, 0, created.result.stderr);
  assert.equal(created.output.distTag, "next");
  assert.match(created.calls, /--prerelease=true --latest=false/);
  const recovered = runRelease({
    branch: "next",
    advanceMain: true,
    baselineVersion: "0.2.1",
    existingTag: "v0.3.0-beta.0",
    extraTag: "v0.3.0",
    expectedVersion: "0.3.0-beta.0",
  });
  assert.equal(recovered.result.status, 0, recovered.result.stderr);
  assert.equal(recovered.output.state, "recover");
  assert.match(
    recovered.calls,
    /gh release create v0\.3\.0-beta\.0.*--prerelease=true --latest=false/,
  );
});

test("new releases refuse a stale branch head", () => {
  const execution = runRelease({
    branch: "next",
    advanceMain: true,
    baselineVersion: "0.2.1",
    expectedVersion: "0.3.0-beta.0",
  });
  assert.notEqual(execution.result.status, 0);
  assert.match(execution.result.stderr, /next advanced/);
  assert.doesNotMatch(execution.calls, /create |gh release/);
});
