import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";
import type { ProcessIdentity } from "@seqlane/action-service-lifecycle";
import { z } from "zod";

const MAX_SOCKET_COMMAND_TIMEOUT_MILLISECONDS = 600_000;

export interface SocketCommandOptions {
  readonly maxBuffer: number;
  readonly timeout: number;
  readonly signal?: AbortSignal;
}

export type SocketCommandRunner = (
  command: string,
  args: string[],
  options: SocketCommandOptions,
) => Promise<{ readonly stdout: string }>;

export type ProcessIdentityReader = (
  pid: number,
) => Promise<ProcessIdentity | undefined>;

export interface ListeningEndpoint {
  readonly host: string;
  readonly port: number;
  readonly pid: number;
}

const commandErrorCodeSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
});

class SocketCommandError extends Error {
  readonly code: string | number | undefined;

  constructor(message: string, code?: string | number, cause?: unknown) {
    super(message, { cause });
    this.name = "SocketCommandError";
    this.code = code;
  }
}

export async function runSocketCommand(
  command: string,
  args: string[],
  options: SocketCommandOptions,
): Promise<{ readonly stdout: string }> {
  if (options.signal?.aborted)
    throw new Error("Socket ownership command was interrupted");
  const program = Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(command, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        forceKillAfter: "100 millis",
      });
      const chunks: Uint8Array[] = [];
      let outputBytes = 0;
      const output = Stream.runForEach(child.stdout, (chunk) =>
        Effect.suspend(() => {
          outputBytes += chunk.byteLength;
          if (outputBytes > options.maxBuffer)
            return Effect.fail(
              new Error("Socket ownership command output exceeded its limit"),
            );
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      const [code] = yield* Effect.all([child.exitCode, output], {
        concurrency: "unbounded",
      });
      if (code !== 0)
        return yield* Effect.fail(
          new SocketCommandError(
            `Socket ownership command exited with ${code}`,
            code,
          ),
        );
      return { stdout: Buffer.concat(chunks).toString("utf8") };
    }),
  ).pipe(
    Effect.timeout(options.timeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error("Socket ownership command timed out")),
    ),
    Effect.provide(NodeServices.layer),
  );
  try {
    return await Effect.runPromise(
      program,
      options.signal === undefined ? {} : { signal: options.signal },
    );
  } catch (cause) {
    if (options.signal?.aborted)
      throw new Error("Socket ownership command was interrupted", { cause });
    throw cause;
  }
}

export class ListenOwnershipError extends Error {
  constructor() {
    super("Ripwire listen socket is not owned by the spawned process group");
    this.name = "ListenOwnershipError";
  }
}

function processErrorCode(error: unknown): string | number | undefined {
  const parsed = commandErrorCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function parseEndpoint(
  value: string,
): Omit<ListeningEndpoint, "pid"> | undefined {
  const endpoint = value.trim().split("->", 1)[0]?.trim() ?? "";
  const separator = endpoint.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const host = endpoint
    .slice(0, separator)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  const port = Number(endpoint.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return { host, port };
}

export function parseListeningEndpoints(
  stdout: string,
  platform: NodeJS.Platform,
): ListeningEndpoint[] {
  if (platform === "linux") {
    const endpoints: ListeningEndpoint[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const endpoint = parseEndpoint(line.trim().split(/\s+/)[3] ?? "");
      if (!endpoint) continue;
      for (const match of line.matchAll(/\bpid=(\d+)\b/g)) {
        const pid = Number(match[1]);
        if (Number.isInteger(pid) && pid > 0) {
          endpoints.push({ ...endpoint, pid });
        }
      }
    }
    return endpoints;
  }

  const endpoints: ListeningEndpoint[] = [];
  let pid: number | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const pidMatch = line.match(/^p(\d+)$/);
    if (pidMatch) {
      const parsedPid = Number(pidMatch[1]);
      pid =
        Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
      continue;
    }
    if (pid === undefined || !line.startsWith("n")) continue;
    const endpoint = parseEndpoint(line.slice(1));
    if (endpoint) endpoints.push({ ...endpoint, pid });
  }
  return endpoints;
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

function parseListenEndpoint(listen: string): Omit<ListeningEndpoint, "pid"> {
  const endpoint = parseEndpoint(listen);
  if (!endpoint) throw new ListenOwnershipError();
  return endpoint;
}

function endpointHostMatches(
  configuredHost: string,
  actualHost: string,
): boolean {
  if (configuredHost === "0.0.0.0") {
    return actualHost === "0.0.0.0" || actualHost === "*";
  }
  if (configuredHost === "localhost" || configuredHost === "127.0.0.1") {
    return actualHost === "localhost" || actualHost === "127.0.0.1";
  }
  return configuredHost === actualHost;
}

async function listListeningEndpoints(
  listen: string,
  platform: NodeJS.Platform,
  runCommand: SocketCommandRunner,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<ListeningEndpoint[]> {
  const port = parseListenEndpoint(listen).port;
  const command = platform === "linux" ? "/usr/bin/ss" : "/usr/sbin/lsof";
  const args =
    platform === "linux"
      ? ["-H", "-ltnp", `sport = :${port}`]
      : ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"];
  try {
    const result = await runCommand(command, args, {
      maxBuffer: 64 * 1024,
      timeout: timeoutMilliseconds,
      signal,
    });
    return parseListeningEndpoints(result.stdout, platform);
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
  runCommand: SocketCommandRunner = runSocketCommand,
  timeoutMilliseconds = MAX_SOCKET_COMMAND_TIMEOUT_MILLISECONDS,
  signal?: AbortSignal,
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
  const configuredEndpoint = parseListenEndpoint(listen);
  const listeningEndpoints = await listListeningEndpoints(
    listen,
    platform,
    runCommand,
    probeTimeoutMilliseconds,
    signal,
  );
  for (const endpoint of listeningEndpoints) {
    if (
      endpoint.port !== configuredEndpoint.port ||
      !endpointHostMatches(configuredEndpoint.host, endpoint.host)
    ) {
      continue;
    }
    const pid = endpoint.pid;
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
