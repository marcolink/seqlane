import { execFile } from "node:child_process";
import { promisify } from "node:util";
export { buildReadinessArguments } from "./commands.js";

export function mcpUrl(listen: string): string {
  const parsed = new URL(`http://${listen}`);
  if (!parsed.hostname || !parsed.port) {
    throw new Error("listen must contain a hostname and port");
  }
  return `${parsed.origin}/mcp`;
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
