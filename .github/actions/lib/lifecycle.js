import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
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

  child.unref();
  return pid;
}

function processGroupIsAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH" || error?.code === "EINVAL") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    await sleep(100);
  }
  return !processGroupIsAlive(pid);
}

export async function terminateProcessGroup(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!processGroupIsAlive(pid)) return true;

  try {
    if (!signalProcessGroup(pid, "SIGTERM")) return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }

  if (await waitForProcessGroupExit(pid, 5_000)) return true;

  try {
    if (!signalProcessGroup(pid, "SIGKILL")) return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
  return waitForProcessGroupExit(pid, 2_000);
}

export async function waitForHttpHealth(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // The service may still be starting.
    } finally {
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
