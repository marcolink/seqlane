// @test-scope ./archive.ts

import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installArchive } from "./archive.js";
import { resolvePlatform } from "./platform.js";
import { releaseAssetUrl } from "./release.js";

describe("installArchive", () => {
  it("verifies the digest before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      const archive = join(root, "archive");
      await writeFile(archive, "archive");
      const metadata = {
        tag: "v1.18.27",
        assetName: "opencode-linux-x64.tar.gz",
        downloadUrl: releaseAssetUrl("1.18.27", "opencode-linux-x64.tar.gz"),
        sha256: "0".repeat(64),
      };
      const toolCache = {
        downloadTool: vi.fn().mockResolvedValue(archive),
        extractTar: vi.fn(),
        extractZip: vi.fn(),
        cacheDir: vi.fn(),
      };
      await expect(
        installArchive({
          metadata,
          platform: resolvePlatform("linux", "x64"),
          version: "1.18.27",
          toolCachePort: toolCache,
          verifyExecutable: vi.fn(),
          temporaryDirectory: root,
        }),
      ).rejects.toThrow(/SHA-256/);
      expect(toolCache.extractTar).not.toHaveBeenCalled();
      await expect(access(archive)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans temporary archive and extraction files but keeps the installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    const archive = join(root, "archive");
    const installation = join(root, "installation");
    let extractionPath: string | undefined;
    const verifyExecutable = vi.fn().mockResolvedValue(undefined);
    await writeFile(archive, "archive");
    const digest = createHash("sha256").update("archive").digest("hex");
    try {
      const toolCache = {
        downloadTool: vi.fn().mockResolvedValue(archive),
        extractTar: vi
          .fn()
          .mockImplementation(async (download, destination) => {
            expect(download).toBe(archive);
            extractionPath = destination;
            await writeFile(join(destination, "opencode"), "binary");
            return destination;
          }),
        extractZip: vi.fn(),
        cacheDir: vi.fn().mockImplementation(async (source) => {
          await mkdir(installation, { recursive: true });
          await copyFile(
            join(source, "opencode"),
            join(installation, "opencode"),
          );
          return installation;
        }),
      };

      await expect(
        installArchive({
          metadata: {
            tag: "v1.18.27",
            assetName: "opencode-linux-x64.tar.gz",
            downloadUrl: releaseAssetUrl(
              "1.18.27",
              "opencode-linux-x64.tar.gz",
            ),
            sha256: digest,
          },
          platform: resolvePlatform("linux", "x64"),
          version: "1.18.27",
          toolCachePort: toolCache,
          verifyExecutable,
          temporaryDirectory: root,
        }),
      ).resolves.toBe(join(installation, "opencode"));
      await expect(access(archive)).rejects.toThrow();
      await expect(access(installation)).resolves.toBeUndefined();
      if (extractionPath === undefined)
        throw new Error("Extraction did not run");
      await expect(access(extractionPath)).rejects.toThrow();
      expect(toolCache.cacheDir).toHaveBeenCalled();
      expect(verifyExecutable).toHaveBeenCalledTimes(2);
      expect(verifyExecutable).toHaveBeenLastCalledWith(
        join(installation, "opencode"),
        "1.18.27",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects when the placed executable fails verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    const archive = join(root, "archive");
    const installation = join(root, "installation");
    await writeFile(archive, "archive");
    const digest = createHash("sha256").update("archive").digest("hex");
    try {
      const verifyExecutable = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("placed executable mismatch"));
      const toolCache = {
        downloadTool: vi.fn().mockResolvedValue(archive),
        extractTar: vi
          .fn()
          .mockImplementation(async (_download, destination) => {
            await writeFile(join(destination, "opencode"), "binary");
            return destination;
          }),
        extractZip: vi.fn(),
        cacheDir: vi.fn().mockImplementation(async (source) => {
          await mkdir(installation, { recursive: true });
          await copyFile(
            join(source, "opencode"),
            join(installation, "opencode"),
          );
          return installation;
        }),
      };

      await expect(
        installArchive({
          metadata: {
            tag: "v1.18.27",
            assetName: "opencode-linux-x64.tar.gz",
            downloadUrl: releaseAssetUrl(
              "1.18.27",
              "opencode-linux-x64.tar.gz",
            ),
            sha256: digest,
          },
          platform: resolvePlatform("linux", "x64"),
          version: "1.18.27",
          toolCachePort: toolCache,
          verifyExecutable,
          temporaryDirectory: root,
        }),
      ).rejects.toThrow("placed executable mismatch");
      expect(verifyExecutable).toHaveBeenLastCalledWith(
        join(installation, "opencode"),
        "1.18.27",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
