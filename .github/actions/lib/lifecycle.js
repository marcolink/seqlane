import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function inputName(name) {
  return `INPUT_${name.toUpperCase()}`;
}

export function getInput(name, fallback = "") {
  const value = process.env[inputName(name)] ?? fallback;
  return value.trim();
}

export function getRunnerTempPath(fileName) {
  return join(process.env.RUNNER_TEMP ?? "/tmp", fileName);
}

async function appendCommandFile(fileName, key, value) {
  const commandFile = process.env[fileName];
  if (!commandFile) return;
  await appendFile(
    commandFile,
    `${key}<<seqlane-action\n${value}\nseqlane-action\n`,
  );
}

export function setOutput(key, value) {
  return appendCommandFile("GITHUB_OUTPUT", key, value);
}

export function saveState(key, value) {
  return appendCommandFile("GITHUB_STATE", key, value);
}

export function getState(key) {
  return process.env[`STATE_${key}`] ?? "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function parseLinuxProcessIdentity(contents) {
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

async function readProcessIdentityFromPs(pid) {
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

export async function readProcessIdentity(pidValue) {
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

function normalizeProcessIdentity(identity) {
  if (!identity || typeof identity !== "object") return undefined;
  const processGroupId = positiveInteger(identity.processGroupId);
  const processStartTime =
    typeof identity.processStartTime === "string"
      ? identity.processStartTime.trim()
      : "";
  if (!processGroupId || !processStartTime) return undefined;
  return { processGroupId, processStartTime };
}

async function processIdentityMatches(pid, expectedIdentity) {
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

export async function assertDirectory(directory) {
  const details = await stat(directory);
  if (!details.isDirectory()) {
    throw new Error(
      `Configured working directory is not a directory: ${directory}`,
    );
  }
}

export async function spawnDetached({ command, args, cwd, env, logPath }) {
  await mkdir(dirname(logPath), { recursive: true });
  const logFile = openSync(logPath, "a");
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFile, logFile],
      windowsHide: true,
    });
  } finally {
    closeSync(logFile);
  }

  const pid = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => resolve(child.pid));
  });

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not determine the PID for ${command}`);
  }

  let identity;
  try {
    identity = await readProcessIdentity(pid);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`Could not verify the identity for ${command}`, {
      cause: error,
    });
  }
  if (!identity) {
    child.kill("SIGTERM");
    throw new Error(`Could not verify the identity for ${command}`);
  }

  child.unref();
  return { pid, identity };
}

function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH" || error?.code === "EINVAL") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupIsAlive(processGroupId) && Date.now() < deadline) {
    await sleep(100);
  }
  return !processGroupIsAlive(processGroupId);
}

export async function terminateProcessGroup(pidValue, expectedIdentity) {
  const pid = positiveInteger(pidValue);
  const identity = normalizeProcessIdentity(expectedIdentity);
  if (!pid || !identity) return false;
  if (!(await processIdentityMatches(pid, identity))) return true;
  if (!processGroupIsAlive(identity.processGroupId)) return true;

  try {
    if (!signalProcessGroup(identity.processGroupId, "SIGTERM")) return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }

  if (await waitForProcessGroupExit(identity.processGroupId, 5_000)) {
    return true;
  }

  if (!(await processIdentityMatches(pid, identity))) return true;

  try {
    if (!signalProcessGroup(identity.processGroupId, "SIGKILL")) return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
  return waitForProcessGroupExit(identity.processGroupId, 2_000);
}

export async function persistProcessState({ pid, identity }) {
  const normalizedIdentity = normalizeProcessIdentity(identity);
  if (!normalizedIdentity) {
    throw new Error("Cannot persist an unverified process identity");
  }

  try {
    await saveState("pid", String(pid));
    await saveState(
      "process-group-id",
      String(normalizedIdentity.processGroupId),
    );
    await saveState("process-start-time", normalizedIdentity.processStartTime);
  } catch (error) {
    try {
      const stopped = await terminateProcessGroup(pid, normalizedIdentity);
      if (!stopped) {
        console.warn(
          `Process group ${pid} could not be verified during cleanup`,
        );
      }
    } catch (cleanupError) {
      console.warn(`Startup cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

export async function waitForHttpHealth(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        return;
      }
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

export async function waitForCommandHealth(check, timeoutMilliseconds, name) {
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

export async function runReadinessCommand({ command, args, cwd, env }) {
  await execFileAsync(command, args, {
    cwd,
    env,
    maxBuffer: 1_024 * 1_024,
    timeout: 3_000,
  });
}

export function reportFailure(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
