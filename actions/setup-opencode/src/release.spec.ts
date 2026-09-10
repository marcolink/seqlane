// @test-scope ./release.ts

import { describe, expect, it } from "vitest";
import { resolvePlatform } from "./platform.js";
import { parseReleaseMetadata, releaseAssetUrl } from "./release.js";

const version = "1.18.27";
const platform = resolvePlatform("linux", "x64");
const digest = "sha256:" + "a".repeat(64);

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    assets: [
      {
        name: platform.assetName,
        browser_download_url: releaseAssetUrl(version, platform.assetName),
        digest,
      },
    ],
    ...overrides,
  };
}

describe("parseReleaseMetadata", () => {
  it("selects the exact asset and digest", () => {
    expect(parseReleaseMetadata(release(), version, platform)).toEqual({
      tag: `v${version}`,
      assetName: platform.assetName,
      downloadUrl: releaseAssetUrl(version, platform.assetName),
      sha256: "a".repeat(64),
    });
  });

  it.each([
    ["wrong tag", release({ tag_name: "v1.18.26" })],
    [
      "missing digest",
      release({
        assets: [
          {
            name: platform.assetName,
            browser_download_url: releaseAssetUrl(version, platform.assetName),
          },
        ],
      }),
    ],
    [
      "wrong digest",
      release({
        assets: [
          {
            name: platform.assetName,
            browser_download_url: releaseAssetUrl(version, platform.assetName),
            digest: "sha256:bad",
          },
        ],
      }),
    ],
    [
      "duplicate asset",
      release({ assets: [release().assets[0], release().assets[0]] }),
    ],
    [
      "wrong URL",
      release({
        assets: [
          {
            name: platform.assetName,
            browser_download_url: "https://example.com/opencode.tar.gz",
            digest,
          },
        ],
      }),
    ],
    ["unknown response", { tag_name: `v${version}`, assets: "nope" }],
  ])("rejects %s metadata", (_label, value) => {
    expect(() => parseReleaseMetadata(value, version, platform)).toThrow();
  });
});
