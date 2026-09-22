// @test-scope ./recover-release.mjs
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
import { spawnSync } from "node:child_process";
import test from "node:test";

import { recoveryReleaseConfig } from "./recover-release.mjs";

const nxConfig = JSON.parse(
  readFileSync(new URL("../nx.json", import.meta.url), "utf8"),
);
const publishWorkflow = readFileSync(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const publishCommand =
  nxConfig.targetDefaults["nx-release-publish"].options.command;

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

    for (const executable of ["pnpm", "npm"]) {
      const executablePath = join(binDirectory, executable);
      writeFileSync(
        executablePath,
        `#!/bin/sh\nprintf '%s' '${executable}' >> '${callsFile}'\nprintf ' %s' "$@" >> '${callsFile}'\nprintf '\\n' >> '${callsFile}'\n${executable === "npm" ? `if [ "$1" = "view" ]; then exit ${published ? 0 : 1}; fi\n` : ""}`,
      );
      chmodSync(executablePath, 0o755);
    }

    const environment = {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
    };
    if (nxDryRun === undefined) {
      delete environment.NX_DRY_RUN;
    } else {
      environment.NX_DRY_RUN = nxDryRun;
    }

    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        publishCommand
          .replaceAll("{projectRoot}", "package")
          .replaceAll("{projectName}", "fixture"),
      ],
      {
        cwd: temporaryRoot,
        encoding: "utf8",
        env: environment,
      },
    );
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n")
      : [];

    return { calls, result };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function extractReleaseStepScript() {
  const stepMarker = "      - name: Create release tag and GitHub release\n";
  const stepStart = publishWorkflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1);
  const runStart = publishWorkflow.indexOf("        run: |\n", stepStart);
  const envStart = publishWorkflow.indexOf("        env:\n", runStart);
  assert.notEqual(runStart, -1);
  assert.notEqual(envStart, -1);

  return publishWorkflow
    .slice(runStart + "        run: |\n".length, envStart)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("publish target fails before packing when dry-run intent is absent", () => {
  const { calls, result } = runPublishCommand(undefined);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NX_DRY_RUN must be explicitly set/);
  assert.deepEqual(calls, []);
});

test("publish target forwards explicit dry-run intent to npm", () => {
  const { calls, result } = runPublishCommand("true");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^pnpm .* pack /);
  assert.match(calls[1], /^npm publish .* --dry-run=true$/);
});

test("publish target skips an exact version already present on npm", () => {
  const { calls, result } = runPublishCommand("false", true);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^pnpm .* pack /);
  assert.equal(calls[1], "npm view @seqlane/fixture@0.0.1 version --json");
});

test("publish target publishes an exact version missing from npm", () => {
  const { calls, result } = runPublishCommand("false", false);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 3);
  assert.equal(calls[1], "npm view @seqlane/fixture@0.0.1 version --json");
  assert.match(calls[2], /^npm publish .* --dry-run=false$/);
});

test("release workflow tags without a release commit or bypass token", () => {
  assert.match(publishWorkflow, /release_args=\(--skip-publish\)/);
  assert.doesNotMatch(publishWorkflow, /release_args=.*--yes/);
  assert.match(publishWorkflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(publishWorkflow, /secrets\.RELEASE_GITHUB_TOKEN/);
  assert.match(publishWorkflow, /gh release view .*--json body/);
  assert.match(publishWorkflow, /GITHUB_STEP_SUMMARY/);
  assert.match(publishWorkflow, /summary_limit=500000/);
  assert.match(publishWorkflow, /GIT_CONFIG_KEY_0/);
  assert.ok(
    publishWorkflow.indexOf("GIT_CONFIG_KEY_0") <
      publishWorkflow.indexOf("git fetch --tags"),
  );
  assert.doesNotMatch(publishWorkflow, /git remote set-url/);
  assert.equal(nxConfig.release.git.commit, false);
  assert.equal(nxConfig.release.git.tag, true);
  assert.equal(nxConfig.release.git.push, true);
});

test("release recovery moves Git settings to the changelog command", () => {
  const recoveryConfig = recoveryReleaseConfig(nxConfig);

  assert.equal(recoveryConfig.git, undefined);
  assert.deepEqual(recoveryConfig.changelog.git, {
    commit: false,
    push: false,
    tag: false,
  });
  assert.equal(
    recoveryConfig.changelog.workspaceChangelog.createRelease,
    false,
  );
});

function runReleaseStep({ existingTag, advanceMain = false }) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-release-retry-"));
  const remote = join(temporaryRoot, "remote.git");
  const repository = join(temporaryRoot, "repository");
  const binDirectory = join(temporaryRoot, "bin");
  const callsFile = join(temporaryRoot, "calls.log");
  const releaseState = join(temporaryRoot, "release-created");
  const outputFile = join(temporaryRoot, "github-output");
  const summaryFile = join(temporaryRoot, "github-summary");

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
    runGit(repository, ["tag", "v0.0.0"]);
    writeFileSync(join(repository, "fixture.txt"), "release\n");
    runGit(repository, ["commit", "-am", "fix: release"]);
    const releaseSha = runGit(repository, ["rev-parse", "HEAD"]);
    if (existingTag) runGit(repository, ["tag", "v0.0.1"]);
    runGit(repository, ["remote", "add", "origin", remote]);
    runGit(repository, ["push", "origin", "main", "--tags"]);

    if (advanceMain) {
      writeFileSync(join(repository, "fixture.txt"), "advanced\n");
      runGit(repository, ["commit", "-am", "fix: advance main"]);
      runGit(repository, ["push", "origin", "main"]);
      runGit(repository, ["checkout", "--detach", releaseSha]);
    }

    const pnpmPath = join(binDirectory, "pnpm");
    writeFileSync(
      pnpmPath,
      `#!/bin/sh
printf 'pnpm %s\\n' "$*" >> '${callsFile}'
case "$*" in
  "exec nx release --skip-publish --first-release")
    git tag v0.0.1
    git push origin v0.0.1 >/dev/null
    : > '${releaseState}'
    ;;
esac
`,
    );
    chmodSync(pnpmPath, 0o755);

    const nodePath = join(binDirectory, "node");
    writeFileSync(
      nodePath,
      `#!/bin/sh
printf 'node %s\\n' "$*" >> '${callsFile}'
printf '%s\\n' 'Retry release notes' > CHANGELOG.md
`,
    );
    chmodSync(nodePath, 0o755);

    const ghPath = join(binDirectory, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
printf 'gh %s\\n' "$*" >> '${callsFile}'
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ ! -f '${releaseState}' ]; then
    exit 1
  fi
  case "$*" in
    *"--json body"*) printf '%s\\n' 'Retry release notes' ;;
  esac
elif [ "$1" = "release" ] && { [ "$2" = "create" ] || [ "$2" = "edit" ]; }; then
  : > '${releaseState}'
fi
`,
    );
    chmodSync(ghPath, 0o755);

    const result = spawnSync(
      "/bin/bash",
      ["-e", "-o", "pipefail", "-c", extractReleaseStepScript()],
      {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH}`,
          GITHUB_OUTPUT: outputFile,
          GITHUB_REPOSITORY: "marcolink/seqlane",
          GITHUB_SHA: releaseSha,
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_TOKEN: "test-release-token",
          GH_TOKEN: "test-release-token",
        },
      },
    );

    return {
      calls: readFileSync(callsFile, "utf8"),
      config: readFileSync(join(repository, ".git", "config"), "utf8"),
      origin: runGit(repository, ["remote", "get-url", "origin"]),
      output: readFileSync(outputFile, "utf8"),
      remote,
      remoteTags: runGit(repository, ["ls-remote", "--tags", "origin"]),
      result,
      summary: readFileSync(summaryFile, "utf8"),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("release workflow creates a first release from an untagged commit", () => {
  const execution = runReleaseStep({ existingTag: false });

  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.match(
    execution.calls,
    /pnpm exec nx release --skip-publish --first-release/,
  );
  assert.match(execution.output, /first_release=true/);
  assert.match(execution.output, /released=true/);
  assert.match(execution.remoteTags, /refs\/tags\/v0\.0\.1/);
  assert.match(execution.summary, /Retry release notes/);
});

test("release workflow resumes a first release after its tag and main advance", () => {
  const execution = runReleaseStep({
    existingTag: true,
    advanceMain: true,
  });

  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.match(
    execution.calls,
    /pnpm exec nx release version 0\.0\.1 --stage-changes=false --git-commit=false --git-tag=false --git-push=false/,
  );
  assert.match(
    execution.calls,
    /node scripts\/recover-release\.mjs 0\.0\.1 v0\.0\.0 [0-9a-f]{40}/,
  );
  assert.match(
    execution.calls,
    /gh release create v0\.0\.1 --verify-tag --title v0\.0\.1 --notes-file CHANGELOG\.md/,
  );
  assert.doesNotMatch(execution.calls, /--generate-notes/);
  assert.match(execution.output, /first_release=true/);
  assert.match(execution.output, /released=true/);
  assert.match(execution.summary, /Retry release notes/);
  assert.doesNotMatch(execution.config, /test-release-token/);
  assert.equal(execution.origin, execution.remote);
});
