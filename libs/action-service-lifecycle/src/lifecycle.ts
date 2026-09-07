import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface ProcessIdentity {
  processGroupId: number;
  processStartTime: string;
}

export interface DetachedProcess {
  pid: number;
  identity: ProcessIdentity;
  anchor: ChildProcess;
}

export interface SpawnDetachedOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  anchorPath: string;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function processErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function parseLinuxProcessIdentity(contents: string): ProcessIdentity {
  const commandEnd = contents.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("Invalid Linux process metadata");
  const fields = contents
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const processGroupId = positiveInteger(fields[2]);
  const processStartTime = fields[19];
  if (!processGroupId || !processStartTime) {
    throw new Error("Incomplete Linux process metadata");
  }
  return { processGroupId, processStartTime };
}

async function readProcessIdentityFromPs(
  pid: number,
): Promise<ProcessIdentity> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
    { maxBuffer: 16 * 1024 },
  );
  const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  const processGroupId = positiveInteger(match?.[2]);
  const processStartTime = match?.[3]?.trim();
  if (!processGroupId || !processStartTime) {
    throw new Error("Incomplete process metadata");
  }
  return { processGroupId, processStartTime };
}

export async function readProcessIdentity(
  pidValue: unknown,
): Promise<ProcessIdentity | undefined> {
  const pid = positiveInteger(pidValue);
  if (!pid) return undefined;
  if (process.platform === "linux") {
    return parseLinuxProcessIdentity(
      await readFile(`/proc/${pid}/stat`, "utf8"),
    );
  }
  if (process.platform === "darwin") return readProcessIdentityFromPs(pid);
  return undefined;
}

function normalizeProcessIdentity(
  identity: unknown,
): ProcessIdentity | undefined {
  if (!identity || typeof identity !== "object") return undefined;
  const value = identity as {
    processGroupId?: unknown;
    processStartTime?: unknown;
  };
  const processGroupId = positiveInteger(value.processGroupId);
  const processStartTime =
    typeof value.processStartTime === "string"
      ? value.processStartTime.trim()
      : "";
  if (!processGroupId || !processStartTime) return undefined;
  return { processGroupId, processStartTime };
}

async function processIdentityMatches(
  pid: number,
  expectedIdentity: ProcessIdentity,
): Promise<boolean> {
  try {
    const currentIdentity = await readProcessIdentity(pid);
    return (
      currentIdentity?.processGroupId === expectedIdentity.processGroupId &&
      currentIdentity?.processStartTime === expectedIdentity.processStartTime
    );
  } catch {
    return false;
  }
}

export async function assertDirectory(directory: string): Promise<void> {
  const details = await stat(directory);
  if (!details.isDirectory()) {
    throw new Error(
      `Configured working directory is not a directory: ${directory}`,
    );
  }
}

export async function spawnDetached({
  command,
  args,
  cwd,
  env,
  logPath,
  anchorPath,
}: SpawnDetachedOptions): Promise<DetachedProcess> {
  await mkdir(dirname(logPath), { recursive: true });
  const logFile = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [anchorPath, command, JSON.stringify(args)],
      {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", logFile, logFile, "ipc"],
        windowsHide: true,
      },
    );
  } finally {
    closeSync(logFile);
  }

  const anchorReady = waitForAnchorReady(child);
  anchorReady.catch(() => undefined);
  const pid = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => resolve(child.pid ?? 0));
  });

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not determine the PID for ${command}`);
  }

  let identity: ProcessIdentity | undefined;
  try {
    identity = await readProcessIdentity(pid);
    if (!identity) {
      throw new Error(`Could not verify the identity for ${command}`);
    }
    await anchorReady;
    return { pid, identity, anchor: child };
  } catch (error) {
    await terminateFailedAnchor(child, pid, identity);
    throw new Error(`Could not start anchored process for ${command}`, {
      cause: error,
    });
  }
}

function waitForAnchorReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(reject, new Error("Process anchor did not become ready"));
    }, 5_000);

    const finish = (handler: (value?: unknown) => void, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      child.off("disconnect", onDisconnect);
      handler(value);
    };
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ready"
      ) {
        finish(resolve as (value?: unknown) => void);
      } else if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "error"
      ) {
        const messageValue =
          "message" in message && typeof message.message === "string"
            ? message.message
            : "Process anchor failed";
        finish(reject, new Error(messageValue));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        reject,
        new Error(
          `Process anchor exited before readiness (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    };
    const onError = (error: Error) => finish(reject, error);
    const onDisconnect = () =>
      finish(
        reject,
        new Error("Process anchor IPC disconnected before readiness"),
      );

    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    child.once("disconnect", onDisconnect);
  });
}

function adoptAnchor(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || typeof child.send !== "function") {
      reject(new Error("Process anchor IPC is not connected"));
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      finish(reject, new Error("Process anchor adoption timed out"));
    }, 1_000);
    const finish = (handler: (value?: unknown) => void, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
      child.off("error", onError);
      handler(value);
    };
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "adopted"
      ) {
        finish(resolve as (value?: unknown) => void);
      }
    };
    const onDisconnect = () =>
      finish(
        reject,
        new Error("Process anchor IPC disconnected during adoption"),
      );
    const onError = (error: Error) => finish(reject, error);
    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);
    child.once("error", onError);
    child.send({ type: "adopt" }, (error) => {
      if (error) finish(reject, error);
    });
  });
}

function disconnectAnchor(child: ChildProcess): void {
  if (!child.connected) return;
  try {
    child.disconnect();
  } catch {
    // The anchor may have exited after sending its readiness message.
  }
}

/** Adopt the anchor so the service outlives the action's Node process. */
export async function adoptDetachedProcess(
  service: DetachedProcess,
): Promise<void> {
  try {
    await adoptAnchor(service.anchor);
    disconnectAnchor(service.anchor);
    service.anchor.unref();
  } catch (error) {
    disconnectAnchor(service.anchor);
    throw error;
  }
}

async function terminateFailedAnchor(
  child: ChildProcess,
  pid: number,
  identity: ProcessIdentity | undefined,
): Promise<void> {
  disconnectAnchor(child);
  if (identity) {
    try {
      await terminateProcessGroup(pid, identity);
      return;
    } catch {
      // Fall through to direct anchor cleanup if group cleanup cannot run.
    }
  }

  await waitForChildExit(child, 1_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMilliseconds);
    child.once("exit", done);
    function done() {
      clearTimeout(timeout);
      resolve();
    }
  });
}

function processGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return processErrorCode(error) === "EPERM";
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    const code = processErrorCode(error);
    if (code === "ESRCH" || code === "EINVAL") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupIsAlive(processGroupId) && Date.now() < deadline) {
    await sleep(100);
  }
  return !processGroupIsAlive(processGroupId);
}

export async function terminateProcessGroup(
  pidValue: unknown,
  expectedIdentity: unknown,
): Promise<boolean> {
  const pid = positiveInteger(pidValue);
  const identity = normalizeProcessIdentity(expectedIdentity);
  if (!pid || !identity) return false;
  if (!processGroupIsAlive(identity.processGroupId)) return true;
  if (!(await processIdentityMatches(pid, identity))) return false;

  if (!signalProcessGroup(identity.processGroupId, "SIGTERM")) return true;
  if (await waitForProcessGroupExit(identity.processGroupId, 5_000)) {
    return true;
  }

  if (!(await processIdentityMatches(pid, identity))) return false;
  if (!signalProcessGroup(identity.processGroupId, "SIGKILL")) return true;
  return waitForProcessGroupExit(identity.processGroupId, 2_000);
}

export async function waitForHttpHealth(
  url: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    let response: Response | undefined;
    try {
      response = await fetch(url, { signal: controller.signal });
      if (response.ok) return;
    } catch {
      // The service may still be starting.
    } finally {
      try {
        await response?.body?.cancel();
      } catch {
        // Ignore body cleanup failures while the service is starting.
      }
      clearTimeout(timeout);
    }
    await sleep(1_000);
  }
  throw new Error(`Service did not become ready: ${url}`);
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
  await execFileAsync(command, args, {
    cwd,
    env,
    maxBuffer: 1_024 * 1_024,
    timeout: 3_000,
  });
}
