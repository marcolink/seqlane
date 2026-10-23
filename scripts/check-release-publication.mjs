import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  channelVersion,
  compareVersions,
  releaseChannel,
  releaseVersionSchema,
} from "./release-channel.mjs";

const manifestSchema = z.object({
  name: z.string().regex(/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/),
  version: releaseVersionSchema,
});
const registryErrorSchema = z.object({
  error: z.object({ code: z.literal("E404") }),
});
const distTagsSchema = z.record(z.string(), z.string());

function npmView(args, schema, allowMissing = false) {
  const result = spawnSync("npm", ["view", ...args, "--json"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const value = JSON.parse(result.stdout);
  if (result.status === 0) return schema.parse(value);
  if (allowMissing && registryErrorSchema.safeParse(value).success)
    return undefined;
  throw new Error(`npm registry lookup failed: ${result.stderr}`, {
    cause: result,
  });
}

export function checkReleasePublication(
  projectRoot,
  environment = process.env,
) {
  const dryRun = z.enum(["true", "false"]).parse(environment.NX_DRY_RUN);
  const branch =
    environment.SEQLANE_RELEASE_BRANCH ??
    environment.GITHUB_REF_NAME ??
    (dryRun === "true" ? "main" : undefined);
  const channel = releaseChannel(branch);
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")),
  );
  channelVersion(manifest.version, channel);
  if (manifest.version === "0.0.0")
    throw new Error("Version the release manifests before publication");
  if (dryRun === "true") return channel.distTag;

  const existing = npmView(
    [`${manifest.name}@${manifest.version}`, "version"],
    releaseVersionSchema,
    true,
  );
  if (existing !== undefined) {
    if (existing !== manifest.version)
      throw new Error("Registry version does not match the requested release");
    return "skip";
  }
  const tags = npmView([manifest.name, "dist-tags"], distTagsSchema, true);
  const current = tags?.[channel.distTag];
  if (current !== undefined && compareVersions(current, manifest.version) > 0) {
    throw new Error(
      `Refusing to move ${manifest.name}@${channel.distTag} backward from ${current} to ${manifest.version}`,
    );
  }
  return channel.distTag;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      checkReleasePublication(z.string().min(1).parse(process.argv[2])),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
