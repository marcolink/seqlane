import type { RipwireConfig } from "./config.js";

const CHILD_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "RUNNER_TEMP",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export { CHILD_ENVIRONMENT_KEYS };

export function buildRipwireArguments(config: RipwireConfig): string[] {
  return [
    config.workingDirectory,
    `--listen=${config.listen}`,
    `--top-k=${config.topK}`,
    ...(config.stableOrder ? [] : ["--no-stable"]),
    ...(config.redact ? [] : ["--no-redact"]),
    ...(config.allowRemoteEdits ? ["--allow-remote-edits"] : []),
  ];
}

export function buildRipwireEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  binaryDirectory: string,
  token: string | undefined,
): NodeJS.ProcessEnv {
  const path = baseEnvironment.PATH
    ? `${binaryDirectory}${process.platform === "win32" ? ";" : ":"}${baseEnvironment.PATH}`
    : binaryDirectory;
  const environment: NodeJS.ProcessEnv = { PATH: path };
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = baseEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }
  if (token !== undefined) environment.RIPWIRE_MCP_TOKEN = token;
  return environment;
}
