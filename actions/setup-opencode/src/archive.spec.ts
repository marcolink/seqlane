// @test-scope ./archive.ts
// @test-scope ./io.ts

import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createExecutableRunner, verifyExecutableVersion } from "./io.js";
import { installArchive } from "./archive.js";
import { resolvePlatform } from "./platform.js";
import { releaseAssetUrl } from "./release.js";

describe("installArchive", () => {
  it("retains archive and extraction files until interrupted verification settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    const archive = join(root, "archive");
    const controller = new AbortController();
    let extractionPath: string | undefined;
    let signalAborted: (() => void) | undefined;
    const didAbort = new Promise<void>((resolve) => {
      signalAborted = resolve;
    });
    let settleVerification: (() => void) | undefined;
    let verificationSettled = false;
    let installSettled = false;
    let running: Promise<string> | undefined;
    await writeFile(archive, "archive");
    const digest = createHash("sha256").update("archive").digest("hex");
    const toolCache = {
      downloadTool: vi.fn().mockResolvedValue(archive),
      extractTar: vi.fn().mockImplementation(async (_download, destination) => {
        extractionPath = destination;
        await writeFile(join(destination, "opencode"), "binary");
        return destination;
      }),
      extractZip: vi.fn(),
      cacheDir: vi.fn(),
    };
    const verifyExecutable = vi.fn(
      (_executable: string, _version: string, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          settleVerification = () => {
            verificationSettled = true;
            resolve();
          };
          signal.addEventListener("abort", () => signalAborted?.(), {
            once: true,
          });
        }),
    );
    try {
      running = Effect.runPromise(
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
        { signal: controller.signal },
      );
      void running.then(
        () => {
          installSettled = true;
        },
        () => {
          installSettled = true;
        },
      );
      for (
        let attempt = 0;
        attempt < 100 && !verifyExecutable.mock.calls.length;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort(new Error("verification canceled"));
      await didAbort;
      await Promise.resolve();
      expect(verificationSettled).toBe(false);
      expect(installSettled).toBe(false);
      await expect(access(archive)).resolves.toBeUndefined();
      const capturedExtractionPath = extractionPath;
      if (capturedExtractionPath === undefined) {
        throw new Error("Extraction path was not captured.");
      }
      await expect(access(capturedExtractionPath)).resolves.toBeUndefined();
      settleVerification?.();
      await expect(running).rejects.toBeDefined();
      expect(installSettled).toBe(true);
      await expect(access(archive)).rejects.toThrow();
      await expect(access(capturedExtractionPath)).rejects.toThrow();
    } finally {
      controller.abort(new Error("verification test cleanup"));
      settleVerification?.();
      await running?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const stage of ["extracted", "installed"] as const) {
    it(`stops and drains the ${stage} executable check before temporary cleanup`, async () => {
      const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
      const archive = join(root, "archive");
      const installation = join(root, "installation");
      const pidFile = join(root, "child.pid");
      const childScript = join(root, "opencode");
      const controller = new AbortController();
      let extractionPath: string | undefined;
      let verificationCount = 0;
      let running: Promise<string> | undefined;
      await writeFile(archive, "archive");
      await writeFile(
        childScript,
        `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
      );
      await chmod(childScript, 0o755);
      const digest = createHash("sha256").update("archive").digest("hex");
      const verifyExecutable = async (
        executable: string,
        version: string,
        signal: AbortSignal,
      ) => {
        verificationCount += 1;
        if ((stage === "extracted") !== (verificationCount === 1)) return;
        return verifyExecutableVersion(
          executable,
          version,
          createExecutableRunner(30_000),
          signal,
        );
      };
      const toolCache = {
        downloadTool: vi.fn().mockResolvedValue(archive),
        extractTar: vi
          .fn()
          .mockImplementation(async (_download, destination) => {
            extractionPath = destination;
            await copyFile(childScript, join(destination, "opencode"));
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
      try {
        running = Effect.runPromise(
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
          { signal: controller.signal },
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            await access(pidFile);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        const pid = Number(await readFile(pidFile, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) {
          throw new Error(`Controlled child returned invalid PID ${pid}.`);
        }
        controller.abort(new Error("verification canceled"));
        await expect(running).rejects.toBeDefined();
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(access(archive)).rejects.toThrow();
        const capturedExtractionPath = extractionPath;
        if (capturedExtractionPath === undefined) {
          throw new Error("Extraction path was not captured.");
        }
        await expect(access(capturedExtractionPath)).rejects.toThrow();
      } finally {
        controller.abort(new Error("verification test cleanup"));
        await running?.catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });
  }

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
        Effect.runPromise(
          installArchive({
            metadata,
            platform: resolvePlatform("linux", "x64"),
            version: "1.18.27",
            toolCachePort: toolCache,
            verifyExecutable: vi.fn(),
            temporaryDirectory: root,
          }),
        ),
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
        Effect.runPromise(
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
        ),
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
        expect.any(AbortSignal),
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
        Effect.runPromise(
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
        ),
      ).rejects.toThrow("placed executable mismatch");
      expect(verifyExecutable).toHaveBeenLastCalledWith(
        join(installation, "opencode"),
        "1.18.27",
        expect.any(AbortSignal),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("aborts and drains a canceled archive download before cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const archive = join(root, "late-archive");
    let resolveDownload!: (path: string) => void;
    let settled = false;
    const extracted = vi.fn();
    const toolCache = {
      downloadTool: vi.fn(
        (
          _url: string,
          _signal: AbortSignal,
          onAllocated: (path: string) => void,
        ) =>
          new Promise<string>((resolve) => {
            onAllocated(archive);
            void writeFile(archive, "late download");
            started();
            resolveDownload = resolve;
          }),
      ),
      extractTar: extracted,
      extractZip: extracted,
      cacheDir: vi.fn(),
    };
    try {
      const running = Effect.runPromise(
        installArchive({
          metadata: {
            tag: "v1.18.27",
            assetName: "opencode-linux-x64.tar.gz",
            downloadUrl: releaseAssetUrl(
              "1.18.27",
              "opencode-linux-x64.tar.gz",
            ),
            sha256: "0".repeat(64),
          },
          platform: resolvePlatform("linux", "x64"),
          version: "1.18.27",
          toolCachePort: toolCache,
          verifyExecutable: vi.fn(),
          temporaryDirectory: root,
        }),
        { signal: controller.signal },
      );
      void running
        .finally(() => {
          settled = true;
        })
        .catch(() => undefined);
      await didStart;
      controller.abort(new Error("download canceled"));
      await Promise.resolve();
      expect(settled).toBe(false);
      resolveDownload(archive);
      await expect(running).rejects.toBeDefined();
      expect(settled).toBe(true);
      await expect(access(archive)).rejects.toThrow();
      expect(extracted).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
