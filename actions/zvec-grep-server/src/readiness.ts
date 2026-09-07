import { execFile } from "node:child_process";
import { promisify } from "node:util";
export { buildReadinessArguments } from "./commands.js";

export interface ParsedListenAddress {
  readonly listen: string;
  readonly mcpUrl: string;
}

export function parseListenAddress(listen: string): ParsedListenAddress {
  if (listen.trim() !== listen || listen.length === 0) {
    throw new Error("listen must contain a hostname and non-default port");
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://${listen}`);
  } catch {
    throw new Error("listen must contain a hostname and non-default port");
  }

  if (
    !parsed.hostname ||
    !parsed.port ||
    Number(parsed.port) <= 0 ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("listen must contain a hostname and non-default port");
  }

  return {
    listen: parsed.host,
    mcpUrl: `${parsed.origin}/mcp`,
  };
}

export function mcpUrl(listen: string): string {
  return parseListenAddress(listen).mcpUrl;
}

export async function waitForCommandHealth(
  check: () => Promise<void>,
  timeoutMilliseconds: number,
  name: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch {
      // The service may still be starting.
    }
    await sleep(1_000);
  }
  throw new Error(`${name} did not become ready before the startup timeout`);
}

export async function runReadinessCommand({
  command,
  args,
  cwd,
  env,
}: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await runCommand({ command, args, cwd, env, timeout: 3_000 });
}

export async function runCommand({
  command,
  args,
  cwd,
  env,
  timeout,
}: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout?: number;
}): Promise<void> {
  await execFileAsync(command, [...args], {
    cwd,
    env,
    maxBuffer: 1_024 * 1_024,
    ...(timeout === undefined ? {} : { timeout }),
  });
}

const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
