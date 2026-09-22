import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ReleaseClient } from "nx/release";

const repositoryRoot = new URL("../", import.meta.url);

export function recoveryReleaseConfig(nxJson) {
  const release = structuredClone(nxJson.release);
  delete release.git;
  release.changelog = {
    ...release.changelog,
    git: {
      commit: false,
      push: false,
      tag: false,
    },
    workspaceChangelog: {
      ...release.changelog.workspaceChangelog,
      createRelease: false,
    },
  };
  return release;
}

export async function recoverRelease(version, from, to, dryRun = false) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!from || !to) {
    throw new Error("Recovery requires previous and current Git references");
  }

  const nxJson = JSON.parse(
    readFileSync(new URL("nx.json", repositoryRoot), "utf8"),
  );
  const client = new ReleaseClient(recoveryReleaseConfig(nxJson), true);
  await client.releaseChangelog({
    createRelease: false,
    dryRun,
    from,
    gitCommit: false,
    gitPush: false,
    gitTag: false,
    to,
    version,
  });
}

async function main() {
  const [version, from, to] = process.argv.slice(2);
  await recoverRelease(version, from, to, process.env.NX_DRY_RUN === "true");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
