import { z } from "zod";
import { OpenCodeV2Error } from "./errors.js";

const environmentSchema = z.record(z.string(), z.string().optional());
const selectedNamesSchema = z
  .string()
  .max(16_384)
  .transform((value) =>
    value.trim() === "" ? [] : value.split(",").map((name) => name.trim()),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .max(256)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      )
      .max(128),
  );
const runtimeNames = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
];

export const serverEnvironmentSchema = environmentSchema.transform((source) => {
  const selected = selectedNamesSchema.parse(
    source.SEQLANE_OPENCODE_V2_ENV ?? "",
  );
  const environment: Record<string, string> = {};
  for (const name of [...runtimeNames, ...selected]) {
    const entry = source[name];
    if (entry !== undefined) environment[name] = entry;
  }
  return environment;
});
export type ServerEnvironment = z.output<typeof serverEnvironmentSchema>;

/** Provider credentials enter the native tool environment only by explicit selection. */
export function createServerEnvironment(value: unknown): ServerEnvironment {
  try {
    return serverEnvironmentSchema.parse(value);
  } catch (cause) {
    throw new OpenCodeV2Error(
      "configuration",
      "managed server environment is invalid",
      cause,
    );
  }
}
