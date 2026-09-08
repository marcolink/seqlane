import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { tryRestore, trySave, type CachePort } from "./cache.js";
import { installArchive, type ToolCachePort } from "./archive.js";
import { locateExecutable } from "./filesystem.js";
import { cacheKey, type SupportedPlatform } from "./platform.js";
import { parseReleaseMetadata, type ReleaseMetadata } from "./release.js";

const TOOL_NAME = "seqlane-opencode";

export interface SetupLogger {
  debug(message: string): void;
}

export interface SetupDependencies {
  cache: CachePort;
  toolCache: ToolCachePort;
  getRelease(version: string): Promise<unknown>;
  verifyExecutable(executable: string, version: string): Promise<void>;
  logger: SetupLogger;
  temporaryDirectory?: string;
  toolCacheRoot?: string;
}

export function toolCacheRoot(): string {
  const configured = process.env.RUNNER_TOOL_CACHE;
  if (configured !== undefined && configured.length > 0) return configured;
  return join(process.env.RUNNER_TEMP ?? tmpdir(), "seqlane-tool-cache");
}

export function installationPath(
  platform: Pick<SupportedPlatform, "architecture">,
  version: string,
  root = toolCacheRoot(),
): string {
  return join(root, TOOL_NAME, version, platform.architecture);
}

async function verifyCachedExecutable(
  path: string,
  version: string,
  verifyExecutable: SetupDependencies["verifyExecutable"],
): Promise<string | undefined> {
  try {
    const executable = await locateExecutable(path);
    await verifyExecutable(executable, version);
    return executable;
  } catch {
    return undefined;
  }
}

export async function setupOpenCode(
  version: string,
  platform: SupportedPlatform,
  dependencies: SetupDependencies,
): Promise<string> {
  const key = cacheKey(platform, version);
  const destination = installationPath(
    platform,
    version,
    dependencies.toolCacheRoot,
  );
  await mkdir(destination, { recursive: true });

  const restored = await tryRestore(
    dependencies.cache,
    destination,
    key,
    (error) =>
      dependencies.logger.debug(
        `OpenCode cache restore was unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );
  if (restored) {
    const cachedExecutable = await verifyCachedExecutable(
      destination,
      version,
      dependencies.verifyExecutable,
    );
    if (cachedExecutable !== undefined) return cachedExecutable;
    dependencies.logger.debug("Ignoring corrupt OpenCode cache data.");
  }

  await rm(destination, { recursive: true, force: true });
  const releaseValue = await dependencies.getRelease(version);
  const metadata: ReleaseMetadata = parseReleaseMetadata(
    releaseValue,
    version,
    platform,
  );
  const executable = await installArchive({
    metadata,
    platform,
    version,
    toolCachePort: dependencies.toolCache,
    verifyExecutable: dependencies.verifyExecutable,
    temporaryDirectory: dependencies.temporaryDirectory,
  });
  await trySave(dependencies.cache, destination, key, (error) =>
    dependencies.logger.debug(
      `OpenCode cache save was unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  return executable;
}
