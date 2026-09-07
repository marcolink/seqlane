// @test-scope ./setup.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePlatform } from "./platform.js";
import { releaseAssetUrl } from "./release.js";
import {
  installationPath,
  setupOpenCode,
  type SetupDependencies,
} from "./setup.js";

const version = "1.18.27";
const platform = resolvePlatform("linux", "x64");
const digest = "sha256:" + "a".repeat(64);

function release() {
  return {
    tag_name: `v${version}`,
    assets: [
      {
        name: platform.assetName,
        browser_download_url: releaseAssetUrl(version, platform.assetName),
        digest,
      },
    ],
  };
}

async function dependencies(
  root: string,
  cached = false,
): Promise<SetupDependencies> {
  const destination = installationPath(platform, version);
  await rm(destination, { recursive: true, force: true });
  if (cached) {
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "opencode"), "cached");
  }
  return {
    cache: {
      restore: vi
        .fn()
        .mockResolvedValue(
          cached ? `seqlane-opencode-tool-v1-linux-x64-${version}` : undefined,
        ),
      save: vi.fn().mockResolvedValue(1),
    },
    toolCache: {
      downloadTool: vi.fn(),
      extractTar: vi.fn(),
      extractZip: vi.fn(),
      cacheDir: vi.fn().mockImplementation(async () => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "opencode"), "downloaded");
        return destination;
      }),
    },
    getRelease: vi.fn().mockResolvedValue(release()),
    verifyExecutable: vi.fn().mockResolvedValue(undefined),
    logger: { debug: vi.fn() },
    temporaryDirectory: root,
  };
}

describe("setupOpenCode", () => {
  it("uses a verified exact cache hit without a release request", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      const deps = await dependencies(root, true);
      await expect(setupOpenCode(version, platform, deps)).resolves.toContain(
        "opencode",
      );
      expect(deps.getRelease).not.toHaveBeenCalled();
      expect(deps.toolCache.downloadTool).not.toHaveBeenCalled();
      expect(deps.verifyExecutable).toHaveBeenCalledWith(
        expect.stringContaining("opencode"),
        version,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("downloads the exact version after a cache miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      const deps = await dependencies(root);
      const archive = join(root, "archive");
      await writeFile(archive, "archive");
      deps.toolCache.downloadTool = vi.fn().mockResolvedValue(archive);
      deps.toolCache.extractTar = vi.fn().mockResolvedValue(root);
      // The archive test fixture is not a real release archive; make the digest
      // and placement path explicit so orchestration remains isolated here.
      deps.getRelease = vi.fn().mockResolvedValue({
        ...release(),
        assets: [
          { ...release().assets[0], digest: "sha256:" + "b".repeat(64) },
        ],
      });
      const actual = await import("node:crypto").then(({ createHash }) =>
        createHash("sha256").update("archive").digest("hex"),
      );
      deps.getRelease = vi.fn().mockResolvedValue({
        ...release(),
        assets: [{ ...release().assets[0], digest: `sha256:${actual}` }],
      });
      await writeFile(join(root, "opencode"), "downloaded");
      await expect(setupOpenCode(version, platform, deps)).resolves.toContain(
        "opencode",
      );
      expect(deps.getRelease).toHaveBeenCalledWith(version);
      expect(deps.cache.save).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a corrupt exact cache entry and downloads fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    try {
      const deps = await dependencies(root, true);
      const archive = join(root, "archive");
      await writeFile(archive, "archive");
      deps.toolCache.downloadTool = vi.fn().mockResolvedValue(archive);
      deps.toolCache.extractTar = vi.fn().mockResolvedValue(root);
      await writeFile(join(root, "opencode"), "downloaded");
      const actual = await import("node:crypto").then(({ createHash }) =>
        createHash("sha256").update("archive").digest("hex"),
      );
      deps.getRelease = vi.fn().mockResolvedValue({
        ...release(),
        assets: [{ ...release().assets[0], digest: `sha256:${actual}` }],
      });
      deps.verifyExecutable = vi
        .fn()
        .mockRejectedValueOnce(new Error("wrong cached version"))
        .mockResolvedValue(undefined);

      await expect(setupOpenCode(version, platform, deps)).resolves.toContain(
        "opencode",
      );
      expect(deps.getRelease).toHaveBeenCalledWith(version);
      expect(deps.toolCache.downloadTool).toHaveBeenCalledWith(
        releaseAssetUrl(version, platform.assetName),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
