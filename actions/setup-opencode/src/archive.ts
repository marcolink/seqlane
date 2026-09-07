import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as toolCache from "@actions/tool-cache";
import { locateExecutable, sha256File } from "./filesystem.js";
import type { ReleaseMetadata } from "./release.js";
import type { SupportedPlatform } from "./platform.js";

export type ToolCachePort = Pick<
  typeof toolCache,
  "downloadTool" | "extractTar" | "extractZip" | "cacheDir"
>;

export const actionsToolCache: ToolCachePort = {
  downloadTool: toolCache.downloadTool,
  extractTar: toolCache.extractTar,
  extractZip: toolCache.extractZip,
  cacheDir: toolCache.cacheDir,
};

export async function installArchive({
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
}): Promise<string> {
  const archivePath = await toolCachePort.downloadTool(metadata.downloadUrl);
  let extractionRoot: string | undefined;
  try {
    const actualDigest = await sha256File(archivePath);
    if (actualDigest !== metadata.sha256) {
      throw new Error(
        `OpenCode archive SHA-256 ${actualDigest} does not match release metadata.`,
      );
    }

    extractionRoot = await mkdtemp(
      join(temporaryDirectory, "seqlane-opencode-extract-"),
    );
    const extractedPath =
      platform.archiveKind === "tar.gz"
        ? await toolCachePort.extractTar(archivePath, extractionRoot, "xz")
        : await toolCachePort.extractZip(archivePath, extractionRoot);
    const extractedExecutable = await locateExecutable(extractedPath);
    await verifyExecutable(extractedExecutable, version);
    const installationPath = await toolCachePort.cacheDir(
      extractedPath,
      "seqlane-opencode",
      version,
      platform.architecture,
    );
    return locateExecutable(installationPath);
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined);
    if (extractionRoot !== undefined) {
      await rm(extractionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
