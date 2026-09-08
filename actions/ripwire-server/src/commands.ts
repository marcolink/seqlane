import type { RipwireConfig } from "./config.js";

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
  const environment: NodeJS.ProcessEnv = { ...baseEnvironment, PATH: path };
  delete environment["INPUT_MCP-TOKEN"];
  if (token === undefined) delete environment.RIPWIRE_MCP_TOKEN;
  else environment.RIPWIRE_MCP_TOKEN = token;
  return environment;
}
