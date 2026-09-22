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

const nxConfig = JSON.parse(
  readFileSync(new URL("../nx.json", import.meta.url), "utf8"),
);
const publishCommand =
  nxConfig.targetDefaults["nx-release-publish"].options.command;

function runPublishCommand(nxDryRun) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-publish-target-"));
  const binDirectory = join(temporaryRoot, "bin");
  const callsFile = join(temporaryRoot, "calls.log");

  try {
    mkdirSync(binDirectory);
    mkdirSync(join(temporaryRoot, "package"));
    mkdirSync(join(temporaryRoot, ".nx", "release-packages"), {
      recursive: true,
    });

    for (const executable of ["pnpm", "npm"]) {
      const executablePath = join(binDirectory, executable);
      writeFileSync(
        executablePath,
        `#!/bin/sh\nprintf '%s' '${executable}' >> '${callsFile}'\nprintf ' %s' "$@" >> '${callsFile}'\nprintf '\\n' >> '${callsFile}'\n`,
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
