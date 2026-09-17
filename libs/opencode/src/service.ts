import { spawn, type ChildProcess } from "node:child_process";
import {
  OpenCodeServiceCleanupError,
  OpenCodeServiceStartupError,
} from "./errors.js";

const OPENCODE_HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;

export interface OpenCodeService {
  readonly url: string;
  readonly diagnostics: () => string;
  close(): Promise<void>;
}

export interface StartOpenCodeServiceOptions {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawn?: typeof spawn;
  readonly fetch?: typeof fetch;
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next, "utf8") <= OUTPUT_LIMIT_BYTES
    ? next
    : Buffer.from(next, "utf8").subarray(-OUTPUT_LIMIT_BYTES).toString("utf8");
}

function parseOpenCodeUrl(output: string): string | undefined {
  const match = /opencode server listening on\s+(https?:\/\/[^\s]+)/.exec(
    output,
  );
  if (match?.[1] === undefined) return undefined;
  try {
    const url = new URL(match[1]);
    return url.protocol === "http:" &&
      url.hostname === OPENCODE_HOST &&
      url.port
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function ownedProcessGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      Reflect.get(cause, "code") === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

async function waitForOwnedServiceExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exited =
      process.platform !== "win32" && child.pid !== undefined
        ? !ownedProcessGroupIsAlive(child.pid)
        : child.exitCode !== null || child.signalCode !== null;
    if (exited) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return process.platform !== "win32" && child.pid !== undefined
    ? !ownedProcessGroupIsAlive(child.pid)
    : child.exitCode !== null || child.signalCode !== null;
}

async function stopOwnedProcess(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform !== "win32" && !ownedProcessGroupIsAlive(child.pid)) {
    return;
  }
  if (
    process.platform === "win32" &&
    (child.exitCode !== null || child.signalCode !== null)
  ) {
    return;
  }
  const kill = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (cause) {
        if (
          typeof cause !== "object" ||
          cause === null ||
          Reflect.get(cause, "code") !== "ESRCH"
        ) {
          throw new OpenCodeServiceCleanupError(
            `Could not signal owned OpenCode process group with ${signal}`,
            cause,
          );
        }
      }
    }
    try {
      if (child.kill(signal)) return;
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        Reflect.get(cause, "code") === "ESRCH"
      ) {
        return;
      }
      throw new OpenCodeServiceCleanupError(
        `Could not signal owned OpenCode process with ${signal}`,
        cause,
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    throw new OpenCodeServiceCleanupError(
      `Could not signal owned OpenCode process with ${signal}`,
    );
  };

  kill("SIGTERM");
  if (await waitForOwnedServiceExit(child, timeoutMs)) return;
  kill("SIGKILL");
  if (await waitForOwnedServiceExit(child, Math.min(timeoutMs, 1_000))) {
    return;
  }
  throw new OpenCodeServiceCleanupError(
    "Owned OpenCode process did not exit after SIGKILL",
  );
}

async function waitForOpenCodeReady(options: {
  readonly child: ChildProcess;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly url: () => string | undefined;
  readonly startupFailure: () => unknown;
  readonly fetch: typeof fetch;
}): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (options.signal.aborted) {
      throw new OpenCodeServiceStartupError("OpenCode startup was cancelled");
    }
    const startupFailure = options.startupFailure();
    if (startupFailure !== undefined) throw startupFailure;
    if (options.child.exitCode !== null || options.child.signalCode !== null) {
      throw new OpenCodeServiceStartupError(
        "OpenCode exited before becoming ready",
      );
    }
    const url = options.url();
    if (url !== undefined) {
      try {
        const response = await options.fetch(`${url}/global/health`, {
          signal: AbortSignal.any([
            options.signal,
            AbortSignal.timeout(
              Math.min(2_000, Math.max(1, deadline - Date.now())),
            ),
          ]),
        });
        await response.body?.cancel();
        if (response.ok) return url;
      } catch {
        // The owned service can accept TCP before its health endpoint is ready.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new OpenCodeServiceStartupError(
    "OpenCode did not become ready before the startup timeout",
  );
}

/** Starts one private OpenCode service without changing its native configuration. */
export async function startOpenCodeService(
  options: StartOpenCodeServiceOptions,
): Promise<OpenCodeService> {
  if (options.signal.aborted) {
    throw new OpenCodeServiceStartupError("OpenCode startup was cancelled");
  }
  const start = options.spawn ?? spawn;
  const child = start(
    "opencode",
    ["serve", `--hostname=${OPENCODE_HOST}`, "--port=0", "--print-logs"],
    {
      cwd: options.workspace,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  let endpoint: string | undefined;
  let startupFailure: unknown;
  const onOutput = (chunk: Buffer): void => {
    output = appendBounded(output, chunk);
    endpoint ??= parseOpenCodeUrl(output);
  };
  const onError = (cause: unknown): void => {
    startupFailure = cause;
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  child.on("error", onError);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await stopOwnedProcess(child, shutdownTimeoutMs);
      if (await waitForOwnedServiceExit(child, 0)) {
        child.stdout?.off("data", onOutput);
        child.stderr?.off("data", onOutput);
        child.off("error", onError);
      }
    })();
    return closePromise;
  };

  try {
    const url = await waitForOpenCodeReady({
      child,
      signal: options.signal,
      timeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      url: () => endpoint,
      startupFailure: () => startupFailure,
      fetch: options.fetch ?? fetch,
    });
    return { url, diagnostics: () => output, close };
  } catch (cause) {
    let cleanupFailure: unknown;
    try {
      await close();
    } catch (cleanupCause) {
      cleanupFailure = cleanupCause;
    }
    const primary =
      cause instanceof OpenCodeServiceStartupError
        ? cause
        : new OpenCodeServiceStartupError(
            typeof cause === "object" &&
              cause !== null &&
              Reflect.get(cause, "code") === "ENOENT"
              ? "OpenCode executable is unavailable; install OpenCode and authenticate with its native setup"
              : "OpenCode could not be started",
            cause,
          );
    if (cleanupFailure !== undefined) {
      Object.defineProperty(primary, "cleanupFailure", {
        value: cleanupFailure,
        enumerable: false,
      });
    }
    throw primary;
  }
}
