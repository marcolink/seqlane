import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  adoptDetachedProcess,
  spawnDetached,
  terminateProcessGroup,
  waitForHttpHealth,
  type DetachedProcess,
} from "./lifecycle.js";

const anchorPath = resolve(
  dirname(import.meta.dirname),
  "../../actions/opencode-server/process-anchor.js",
);
const services: DetachedProcess[] = [];
const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
  directories.push(directory);
  return directory;
}

function track(service: DetachedProcess): DetachedProcess {
  services.push(service);
  return service;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} did not exit`);
}

async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || code === "EINVAL") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process group ${processGroupId} did not exit`);
}

async function waitForProcessId(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child may not have started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No child PID was written to ${path}`);
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await terminateProcessGroup(service.pid, service.identity);
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("action service lifecycle", () => {
  it("adopts a detached process so it survives the caller", async () => {
    const directory = await createDirectory();
    const service = track(
      await spawnDetached({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 60_000)"],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
        anchorPath,
      }),
    );

    expect(service.anchor.connected).toBe(true);
    await adoptDetachedProcess(service);
    expect(service.anchor.connected).toBe(false);
    expect(() => process.kill(service.pid, 0)).not.toThrow();
    expect(await terminateProcessGroup(service.pid, service.identity)).toBe(
      true,
    );
    await waitForProcessExit(service.pid);
  }, 15_000);

  it("cleans up when anchor adoption fails", async () => {
    const directory = await createDirectory();
    const service = track(
      await spawnDetached({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 60_000)"],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
        anchorPath,
      }),
    );
    service.anchor.disconnect();

    await expect(adoptDetachedProcess(service)).rejects.toThrow(
      "Process anchor IPC is not connected",
    );
    await waitForProcessExit(service.pid);
    await waitForProcessGroupExit(service.identity.processGroupId);
  }, 15_000);

  it("rejects a nonexistent command without leaving an anchor behind", async () => {
    const directory = await createDirectory();

    await expect(
      spawnDetached({
        command: join(directory, "does-not-exist"),
        args: [],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
        anchorPath,
      }),
    ).rejects.toThrow("Could not start anchored process");
  }, 15_000);

  it("does not signal a process group when its identity changed", async () => {
    const directory = await createDirectory();
    const service = track(
      await spawnDetached({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 60_000)"],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
        anchorPath,
      }),
    );

    expect(
      await terminateProcessGroup(service.pid, {
        processGroupId: service.identity.processGroupId,
        processStartTime: "not-the-recorded-process",
      }),
    ).toBe(false);
    expect(() =>
      process.kill(-service.identity.processGroupId, 0),
    ).not.toThrow();
  }, 15_000);

  it("refuses cleanup when the recorded leader is gone but its group remains", async () => {
    const directory = await createDirectory();
    const childPidPath = join(directory, "child.pid");
    const service = track(
      await spawnDetached({
        command: process.execPath,
        args: [
          "-e",
          `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], { stdio: "ignore" });
writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {}, 1_000);`,
          childPidPath,
        ],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
        anchorPath,
      }),
    );
    const childPid = await waitForProcessId(childPidPath);

    process.kill(service.pid, "SIGKILL");
    await waitForProcessExit(service.pid);
    expect(await terminateProcessGroup(service.pid, service.identity)).toBe(
      false,
    );
    expect(() => process.kill(childPid, 0)).not.toThrow();

    try {
      process.kill(-service.identity.processGroupId, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EINVAL") throw error;
    }
    await waitForProcessGroupExit(service.identity.processGroupId);
  }, 15_000);

  it("kills a resistant descendant after the leader exits on SIGTERM", async () => {
    const directory = await createDirectory();
    const childPidPath = join(directory, "child.pid");
    const service = track(
      await spawnDetached({
        command: process.execPath,
        args: [
          "-e",
          `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], { stdio: "ignore" });
writeFileSync(process.argv[1], String(child.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);`,
          childPidPath,
        ],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
        anchorPath,
      }),
    );
    const childPid = await waitForProcessId(childPidPath);
    expect(() => process.kill(childPid, 0)).not.toThrow();

    expect(await terminateProcessGroup(service.pid, service.identity)).toBe(
      true,
    );
    await waitForProcessExit(childPid);
  }, 15_000);

  it("releases failed HTTP readiness response bodies", async () => {
    const cancelled: boolean[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: false,
        body: { cancel: async () => cancelled.push(true) },
      }) as unknown as Response;

    try {
      await expect(waitForHttpHealth("http://127.0.0.1:1", 1)).rejects.toThrow(
        "Service did not become ready",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(cancelled).toEqual([true]);
  }, 5_000);
});
