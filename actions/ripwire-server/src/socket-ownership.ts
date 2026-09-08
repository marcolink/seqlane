import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessIdentity } from "@seqlane/action-service-lifecycle";

const MAX_SOCKET_COMMAND_TIMEOUT_MILLISECONDS = 600_000;

export interface SocketCommandOptions {
  readonly maxBuffer: number;
  readonly timeout: number;
}

export type SocketCommandRunner = (
  command: string,
  args: string[],
  options: SocketCommandOptions,
) => Promise<{ readonly stdout: string }>;

export type ProcessIdentityReader = (
  pid: number,
) => Promise<ProcessIdentity | undefined>;

const execFileAsync = promisify(execFile) as SocketCommandRunner;

export class ListenOwnershipError extends Error {
  constructor() {
    super("Ripwire listen socket is not owned by the spawned process group");
    this.name = "ListenOwnershipError";
  }
}

function parsePort(listen: string): number {
  const separator = listen.lastIndexOf(":");
  return Number(listen.slice(separator + 1));
}

function processErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return (error as NodeJS.ErrnoException).code;
}

export function parseListeningPids(
  stdout: string,
  platform: NodeJS.Platform,
): number[] {
  const values =
    platform === "linux"
      ? [...stdout.matchAll(/\bpid=(\d+)\b/g)].map((match) => match[1])
      : stdout
          .split(/\r?\n/)
          .filter((line) => /^p\d+$/.test(line))
          .map((line) => line.slice(1));
  return [
    ...new Set(
      values.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

async function listListeningPids(
  listen: string,
  platform: NodeJS.Platform,
  runCommand: SocketCommandRunner,
  timeoutMilliseconds: number,
): Promise<number[]> {
  const port = parsePort(listen);
  const command = platform === "linux" ? "/usr/bin/ss" : "/usr/sbin/lsof";
  const args =
    platform === "linux"
      ? ["-H", "-ltnp", `sport = :${port}`]
      : ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"];
  try {
    const result = await runCommand(command, args, {
      maxBuffer: 64 * 1024,
      timeout: timeoutMilliseconds,
    });
    return parseListeningPids(result.stdout, platform);
  } catch (error) {
    if (processErrorCode(error) === 1 || processErrorCode(error) === "1") {
      return [];
    }
    throw error;
  }
}

export async function assertListenOwnedByProcess(
  listen: string,
  service: { readonly pid: number; readonly identity: ProcessIdentity },
  readIdentity: ProcessIdentityReader,
  platformOrTimeout: NodeJS.Platform | number = process.platform,
  runCommand: SocketCommandRunner = execFileAsync,
  timeoutMilliseconds = MAX_SOCKET_COMMAND_TIMEOUT_MILLISECONDS,
): Promise<void> {
  const platform =
    typeof platformOrTimeout === "number"
      ? process.platform
      : platformOrTimeout;
  const probeTimeoutMilliseconds =
    typeof platformOrTimeout === "number"
      ? platformOrTimeout
      : timeoutMilliseconds;
  if (
    !Number.isSafeInteger(probeTimeoutMilliseconds) ||
    probeTimeoutMilliseconds <= 0 ||
    probeTimeoutMilliseconds > MAX_SOCKET_COMMAND_TIMEOUT_MILLISECONDS
  ) {
    throw new ListenOwnershipError();
  }
  if (platform !== "linux" && platform !== "darwin") {
    throw new ListenOwnershipError();
  }
  const listeningPids = await listListeningPids(
    listen,
    platform,
    runCommand,
    probeTimeoutMilliseconds,
  );
  for (const pid of listeningPids) {
    let identity: ProcessIdentity | undefined;
    try {
      identity = await readIdentity(pid);
    } catch {
      continue;
    }
    if (
      !identity ||
      identity.processGroupId !== service.identity.processGroupId
    )
      continue;
    if (
      pid === service.pid &&
      identity.processStartTime !== service.identity.processStartTime
    ) {
      continue;
    }
    return;
  }
  throw new ListenOwnershipError();
}
