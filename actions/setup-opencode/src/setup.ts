import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";

import { tryRestore, trySave, type CachePort } from "./cache.js";
import { installArchive, type ToolCachePort } from "./archive.js";
import { locateExecutable } from "./filesystem.js";
import { cacheKey, type SupportedPlatform } from "./platform.js";
import { parseReleaseMetadata, type ReleaseMetadata } from "./release.js";

const TOOL_NAME = "seqlane-opencode";
export const SETUP_DEADLINE_MS = 10 * 60 * 1_000;

export interface SetupLogger {
  debug(message: string): void;
}

export interface SetupDependencies {
  cache: CachePort;
  toolCache: ToolCachePort;
  getRelease(version: string, signal?: AbortSignal): Promise<unknown>;
  verifyExecutable(
    executable: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<void>;
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

function verifyCachedExecutable(
  path: string,
  version: string,
  verifyExecutable: SetupDependencies["verifyExecutable"],
): Effect.Effect<string | undefined, unknown> {
  return Effect.tryPromise({
    try: (signal) =>
      locateExecutable(path).then((executable) =>
        verifyExecutable(executable, version, signal).then(() => executable),
      ),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause });

export function setupOpenCode(
  version: string,
  platform: SupportedPlatform,
  dependencies: SetupDependencies,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const key = cacheKey(platform, version);
    const destination = installationPath(
      platform,
      version,
      dependencies.toolCacheRoot,
    );
    yield* io(() => mkdir(destination, { recursive: true }));

    const restored = yield* tryRestore(
      dependencies.cache,
      destination,
      key,
      (error) =>
        dependencies.logger.debug(
          `OpenCode cache restore was unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
    if (restored) {
      const cachedExecutable = yield* verifyCachedExecutable(
        destination,
        version,
        dependencies.verifyExecutable,
      );
      if (cachedExecutable !== undefined) return cachedExecutable;
      dependencies.logger.debug("Ignoring corrupt OpenCode cache data.");
    }

    yield* io(() => rm(destination, { recursive: true, force: true }));
    const releaseValue = yield* io((signal) =>
      dependencies.getRelease(version, signal),
    );
    const metadata: ReleaseMetadata = parseReleaseMetadata(
      releaseValue,
      version,
      platform,
    );
    const executable = yield* installArchive({
      metadata,
      platform,
      version,
      toolCachePort: dependencies.toolCache,
      verifyExecutable: dependencies.verifyExecutable,
      temporaryDirectory: dependencies.temporaryDirectory,
    });
    yield* trySave(dependencies.cache, destination, key, (error) =>
      dependencies.logger.debug(
        `OpenCode cache save was unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return executable;
  });
}
