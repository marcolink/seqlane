import { z } from "zod";
import type { SupportedPlatform } from "./platform.js";

const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/i)
  .transform((value) => value.slice("sha256:".length).toLowerCase());

const releaseAssetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.url(),
  digest: sha256DigestSchema,
});

const releaseSchema = z.object({
  tag_name: z.string().min(1),
  assets: z.array(releaseAssetSchema),
});

export type ReleaseMetadata = {
  tag: string;
  assetName: string;
  downloadUrl: string;
  sha256: string;
};

export function releaseAssetUrl(version: string, assetName: string): string {
  return `https://github.com/anomalyco/opencode/releases/download/v${version}/${assetName}`;
}

export function parseReleaseMetadata(
  value: unknown,
  version: string,
  platform: Pick<SupportedPlatform, "assetName">,
): ReleaseMetadata {
  const parsed = releaseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("OpenCode release metadata is malformed.");
  }

  const expectedTag = `v${version}`;
  if (parsed.data.tag_name !== expectedTag) {
    throw new Error(
      `OpenCode release tag ${parsed.data.tag_name} does not match ${expectedTag}.`,
    );
  }

  const assets = parsed.data.assets.filter(
    (asset) => asset.name === platform.assetName,
  );
  if (assets.length !== 1) {
    throw new Error(
      `OpenCode release must contain exactly one ${platform.assetName} asset.`,
    );
  }

  const [asset] = assets;
  if (asset === undefined) {
    throw new Error("OpenCode release asset is missing.");
  }
  const expectedUrl = releaseAssetUrl(version, platform.assetName);
  if (asset.browser_download_url !== expectedUrl) {
    throw new Error(
      "OpenCode release asset URL is not the official versioned URL.",
    );
  }

  return {
    tag: parsed.data.tag_name,
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
    sha256: asset.digest,
  };
}
