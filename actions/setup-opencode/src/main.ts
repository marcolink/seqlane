import * as core from "@actions/core";
import { dirname } from "node:path";
import { fetchReleaseMetadata, verifyExecutableVersion } from "./io.js";
import { parseVersion } from "./version.js";
import { resolvePlatform } from "./platform.js";
import { actionsCache } from "./cache.js";
import { actionsToolCache } from "./archive.js";
import { setupOpenCode } from "./setup.js";

export async function run(): Promise<void> {
  const version = parseVersion(core.getInput("version", { required: true }));
  const platform = resolvePlatform();
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token !== undefined && token.length > 0) core.setSecret(token);
  const executable = await setupOpenCode(version, platform, {
    cache: actionsCache,
    toolCache: actionsToolCache,
    getRelease: (requestedVersion) =>
      fetchReleaseMetadata(requestedVersion, token),
    verifyExecutable: verifyExecutableVersion,
    logger: {
      debug: (message) => core.debug(message),
    },
  });
  core.addPath(dirname(executable));
  core.setOutput("executable", executable);
}
