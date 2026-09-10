// @test-scope ./platform.ts

import { describe, expect, it } from "vitest";
import { cacheKey, resolvePlatform } from "./platform.js";

describe("resolvePlatform", () => {
  it.each([
    ["linux", "x64", "opencode-linux-x64.tar.gz", "tar.gz"],
    ["linux", "arm64", "opencode-linux-arm64.tar.gz", "tar.gz"],
    ["darwin", "x64", "opencode-darwin-x64.zip", "zip"],
    ["darwin", "arm64", "opencode-darwin-arm64.zip", "zip"],
  ])("maps %s/%s to the official asset", (os, arch, asset, kind) => {
    expect(resolvePlatform(os, arch)).toMatchObject({
      operatingSystem: os,
      architecture: arch,
      assetName: asset,
      archiveKind: kind,
    });
  });

  it.each([
    ["win32", "x64"],
    ["linux", "ia32"],
    ["freebsd", "arm64"],
  ])("rejects unsupported %s/%s before setup", (os, arch) => {
    expect(() => resolvePlatform(os, arch)).toThrow(/Unsupported/);
  });
});

it("creates an exact, version-partitioned cache key", () => {
  const platform = resolvePlatform("linux", "x64");
  expect(cacheKey(platform, "1.18.27")).toBe(
    "seqlane-opencode-tool-v1-linux-x64-1.18.27",
  );
});
