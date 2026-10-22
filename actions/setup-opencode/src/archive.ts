import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import * as toolCache from "@actions/tool-cache";
import { locateExecutable, sha256File } from "./filesystem.js";
import type { ReleaseMetadata } from "./release.js";
import type { SupportedPlatform } from "./platform.js";

export type ToolCachePort = Pick<
  typeof toolCache,
  "extractTar" | "extractZip" | "cacheDir"
> & {
  downloadTool(
    url: string,
    signal: AbortSignal,
    onAllocated: (path: string) => void,
  ): Promise<string>;
};

async function downloadArchive(
  url: string,
  signal: AbortSignal,
  onAllocated: (path: string) => void,
): Promise<string> {
  const path = join(tmpdir(), `seqlane-opencode-${randomUUID()}.archive`);
  onAllocated(path);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || response.body === null) {
      throw new Error(
        `OpenCode archive request failed with HTTP ${response.status}.`,
      );
    }
    const body = response.body;
    async function* chunks(): AsyncGenerator<Buffer> {
      const reader = body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          yield Buffer.from(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    await pipeline(
      Readable.from(chunks()),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    return path;
  } catch (cause) {
    await rm(path, { force: true });
    throw cause;
  }
}

export const actionsToolCache: ToolCachePort = {
  downloadTool: downloadArchive,
  extractTar: toolCache.extractTar,
  extractZip: toolCache.extractZip,
  cacheDir: toolCache.cacheDir,
};

const io = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (cause) => cause });

export function installArchive({
  metadata,
  platform,
  version,
  toolCachePort,
  verifyExecutable,
  temporaryDirectory = tmpdir(),
}: {
  metadata: ReleaseMetadata;
  platform: SupportedPlatform;
  version: string;
  toolCachePort: ToolCachePort;
  verifyExecutable(executable: string, version: string): Promise<void>;
  temporaryDirectory?: string;
}): Effect.Effect<string, unknown> {
  let archivePath: string | undefined;
  const install = Effect.scoped(
    Effect.gen(function* () {
      archivePath = yield* Effect.scoped(
        Effect.gen(function* () {
          const download = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const controller = new AbortController();
              const promise = toolCachePort.downloadTool(
                metadata.downloadUrl,
                controller.signal,
                (path) => {
                  archivePath = path;
                },
              );
              return { controller, promise };
            }),
            ({ controller, promise }) =>
              Effect.promise(async () => {
                controller.abort(
                  new Error("OpenCode archive download interrupted."),
                );
                await promise.then(
                  () => undefined,
                  () => undefined,
                );
              }),
          );
          return yield* Effect.tryPromise({
            try: () => download.promise,
            catch: (cause) => cause,
          });
        }),
      );
      const actualDigest = yield* io(() => sha256File(archivePath!));
      if (actualDigest !== metadata.sha256) {
        return yield* Effect.fail(
          new Error(
            `OpenCode archive SHA-256 ${actualDigest} does not match release metadata.`,
          ),
        );
      }
      const extractionRoot = yield* Effect.acquireRelease(
        io(() =>
          mkdtemp(join(temporaryDirectory, "seqlane-opencode-extract-")),
        ),
        (path) =>
          io(() => rm(path, { recursive: true, force: true })).pipe(
            Effect.catchCause(() => Effect.void),
          ),
      );
      const extractedPath =
        platform.archiveKind === "tar.gz"
          ? yield* Effect.uninterruptible(
              io(() =>
                toolCachePort.extractTar(archivePath!, extractionRoot, "xz"),
              ),
            )
          : yield* Effect.uninterruptible(
              io(() => toolCachePort.extractZip(archivePath!, extractionRoot)),
            );
      const extractedExecutable = yield* io(() =>
        locateExecutable(extractedPath),
      );
      yield* io(() => verifyExecutable(extractedExecutable, version));
      const installationPath = yield* Effect.uninterruptible(
        io(() =>
          toolCachePort.cacheDir(
            extractedPath,
            "seqlane-opencode",
            version,
            platform.architecture,
          ),
        ),
      );
      const installedExecutable = yield* io(() =>
        locateExecutable(installationPath),
      );
      yield* io(() => verifyExecutable(installedExecutable, version));
      return installedExecutable;
    }),
  );
  return install.pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (archivePath !== undefined) {
          yield* io(() => rm(archivePath!, { force: true })).pipe(
            Effect.catchCause(() => Effect.void),
          );
        }
      }),
    ),
  );
}
