import { z } from "zod";

const runnerPlatformSchema = z.object({
  operatingSystem: z.enum(["linux", "darwin"]),
  architecture: z.enum(["x64", "arm64"]),
});

export type SupportedPlatform = {
  operatingSystem: "linux" | "darwin";
  architecture: "x64" | "arm64";
  assetName: string;
  archiveKind: "tar.gz" | "zip";
};

export function resolvePlatform(
  operatingSystem: string = process.platform,
  architecture: string = process.arch,
): SupportedPlatform {
  const parsed = runnerPlatformSchema.safeParse({
    operatingSystem,
    architecture,
  });
  if (!parsed.success) {
    throw new Error(
      `Unsupported OpenCode runner platform: ${operatingSystem}/${architecture}`,
    );
  }

  const { operatingSystem: os, architecture: arch } = parsed.data;
  const prefix = os === "linux" ? "opencode-linux" : "opencode-darwin";
  const suffix = arch === "x64" ? "x64" : "arm64";
  const archiveKind = os === "linux" ? "tar.gz" : "zip";
  return {
    operatingSystem: os,
    architecture: arch,
    assetName: `${prefix}-${suffix}.${archiveKind}`,
    archiveKind,
  };
}

export function cacheKey(
  platform: Pick<SupportedPlatform, "operatingSystem" | "architecture">,
  version: string,
): string {
  return `seqlane-opencode-tool-v1-${platform.operatingSystem}-${platform.architecture}-${version}`;
}
