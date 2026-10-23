import { z } from "zod";

const number = "(?:0|[1-9]\\d*)";
const base = `${number}\\.${number}\\.${number}`;
export const stableVersionSchema = z.string().regex(new RegExp(`^${base}$`));
export const betaVersionSchema = z
  .string()
  .regex(new RegExp(`^${base}-beta\\.${number}$`));
export const releaseVersionSchema = z.union([
  stableVersionSchema,
  betaVersionSchema,
]);
export const releaseRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);

export function releaseChannel(branch) {
  const parsed = z.enum(["main", "next"]).parse(branch);
  const channels = {
    main: { distTag: "latest", preid: "", versionSchema: stableVersionSchema },
    next: { distTag: "next", preid: "beta", versionSchema: betaVersionSchema },
  };
  return { branch: parsed, ...channels[parsed] };
}

export function channelVersion(version, channel) {
  return channel.versionSchema.parse(version);
}

export function compareVersions(left, right) {
  const parts = (value) =>
    releaseVersionSchema
      .parse(value)
      .split(/\.|-beta\./)
      .map(BigInt);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  if (a.length !== b.length) return a.length === 3 ? 1 : -1;
  if (a.length === 3 || a[3] === b[3]) return 0;
  return a[3] > b[3] ? 1 : -1;
}
