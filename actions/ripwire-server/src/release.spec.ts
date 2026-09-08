// @test-scope ./release.ts

import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetNameForPlatform,
  downloadBytes,
  extractBinary,
  installRipwire,
  releaseTarget,
  verifySha256,
  type ReleaseTarget,
} from "./release.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function tarEntry(name: string, contents: Uint8Array, type = "0"): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(name).subarray(0, 100), 0);
  header.set(
    encoder.encode(`${contents.byteLength.toString(8)}\0`).slice(-12),
    124,
  );
  header[156] = type.charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  const paddedSize = Math.ceil(contents.byteLength / 512) * 512;
  const result = new Uint8Array(512 + paddedSize);
  result.set(header);
  result.set(contents, 512);
  return result;
}

function tarArchive(entries: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    entries.reduce((size, entry) => size + entry.byteLength, 0) + 1024,
  );
  let offset = 0;
  for (const entry of entries) {
    result.set(entry, offset);
    offset += entry.byteLength;
  }
  return gzipSync(result);
}

function target(): ReleaseTarget {
  return releaseTarget("v0.4.0", "linux", "x64");
}

describe("Ripwire release acquisition", () => {
  it("maps supported platforms and uses exact versioned URLs", () => {
    expect(assetNameForPlatform("linux", "arm64")).toBe(
      "ripwire-0.4.0-linux-arm64.tar.gz",
    );
    expect(releaseTarget("v0.4.0", "darwin", "x64")).toMatchObject({
      archiveName: "ripwire-0.4.0-macos-x64.tar.gz",
      checksumName: "ripwire-0.4.0-macos-x64.tar.gz.sha256",
      archiveUrl:
        "https://github.com/redhat-et/ripwire/releases/download/v0.4.0/ripwire-0.4.0-macos-x64.tar.gz",
    });
    expect(() => releaseTarget("0.4.0", "aix", "x64")).toThrow(
      "does not publish",
    );
  });

  it("verifies the checksum before extracting the exact binary member", async () => {
    const release = target();
    const bytes = new TextEncoder().encode("binary-version-0.4.0");
    const archive = tarArchive([
      tarEntry(release.rootDirectory, new Uint8Array(), "5"),
      tarEntry(`${release.rootDirectory}ripwire`, bytes),
      tarEntry(
        `${release.rootDirectory}README.md`,
        new TextEncoder().encode("assets"),
      ),
    ]);
    const digest = (await import("node:crypto"))
      .createHash("sha256")
      .update(archive)
      .digest("hex");
    verifySha256(
      archive,
      new TextEncoder().encode(`${digest}  ${release.archiveName}\n`),
      release.archiveName,
    );
    const directory = await mkdtemp(join(tmpdir(), "ripwire-release-test-"));
    temporaryDirectories.push(directory);
    const binaryPath = join(directory, "ripwire");
    extractBinary(archive, release, binaryPath);
    await expect(readFile(binaryPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(stat(binaryPath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });

  it("rejects checksum mismatches, symlinks, and invalid archive members", async () => {
    const release = target();
    const archive = tarArchive([
      tarEntry(release.rootDirectory, new Uint8Array(), "5"),
      tarEntry(
        `${release.rootDirectory}ripwire`,
        new TextEncoder().encode("binary"),
        "2",
      ),
    ]);
    expect(() =>
      verifySha256(
        archive,
        new TextEncoder().encode(`${"0".repeat(64)}  ${release.archiveName}`),
        release.archiveName,
      ),
    ).toThrow("checksum");
    const directory = await mkdtemp(join(tmpdir(), "ripwire-release-test-"));
    temporaryDirectories.push(directory);
    await expect(
      Promise.resolve().then(() =>
        extractBinary(archive, release, join(directory, "ripwire")),
      ),
    ).rejects.toThrow("symlink");
  });

  it("bounds release downloads before accepting their body", async () => {
    await expect(
      downloadBytes("https://example.test/archive", {
        maxBytes: 3,
        fetchImpl: async () => new Response("1234", { status: 200 }),
      }),
    ).rejects.toThrow("size limit");
    await expect(
      downloadBytes("https://example.test/archive", {
        maxBytes: 10,
        fetchImpl: async () =>
          new Response("1234", {
            status: 200,
            headers: { "content-length": "100" },
          }),
      }),
    ).rejects.toThrow("size limit");
  });

  it("rejects an installed binary version mismatch", async () => {
    const release = target();
    const archive = tarArchive([
      tarEntry(release.rootDirectory, new Uint8Array(), "5"),
      tarEntry(
        `${release.rootDirectory}ripwire`,
        new TextEncoder().encode("binary"),
      ),
    ]);
    const digest = (await import("node:crypto"))
      .createHash("sha256")
      .update(archive)
      .digest("hex");
    const directory = await mkdtemp(join(tmpdir(), "ripwire-release-test-"));
    temporaryDirectories.push(directory);
    await expect(
      installRipwire({
        version: "0.4.0",
        runnerTemp: directory,
        platform: "linux",
        architecture: "x64",
        fetchImpl: async (url) => {
          const urlText = typeof url === "string" ? url : url.toString();
          return new Response(
            urlText.endsWith(".sha256")
              ? `${digest}  ${release.archiveName}\n`
              : Buffer.from(archive),
            { status: 200 },
          );
        },
        runVersion: async () => "0.3.9",
      }),
    ).rejects.toThrow("version mismatch");
  });
});
