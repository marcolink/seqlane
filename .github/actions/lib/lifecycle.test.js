import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getState,
  persistProcessState,
  spawnDetached,
  terminateProcessGroup,
  waitForHttpHealth,
} from "./lifecycle.js";

const stateEnvironmentKeys = [
  "GITHUB_STATE",
  "STATE_pid",
  "STATE_PID",
  "STATE_process-group-id",
  "STATE_process-start-time",
];
const originalEnvironment = new Map(
  stateEnvironmentKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of stateEnvironmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Process ${pid} did not exit`);
}

async function waitForProcessGroupExit(processGroupId) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EINVAL") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Process group ${processGroupId} did not exit`);
}

async function waitForProcessId(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child may not have started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`No child PID was written to ${path}`);
}

describe("GitHub Actions lifecycle helpers", { concurrency: false }, () => {
  it("reads the exact state key written by the main action", () => {
    process.env.STATE_pid = "saved-pid";
    process.env.STATE_PID = "different-pid";

    assert.equal(getState("pid"), "saved-pid");
  });

  it("passes saved state to post cleanup and stops the detached process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
    const statePath = join(directory, "state");
    let service;

    try {
      process.env.GITHUB_STATE = statePath;
      service = await spawnDetached({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 60_000)"],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
      });
      assert.equal(service.anchor.connected, true);
      await persistProcessState(service);
      assert.equal(service.anchor.connected, false);

      const state = await readFile(statePath, "utf8");
      assert.match(state, /^pid<<seqlane-action/m);
      assert.match(state, /^process-group-id<<seqlane-action/m);
      assert.match(state, /^process-start-time<<seqlane-action/m);
      assert.doesNotMatch(state, /^log-path<<seqlane-action/m);

      process.env.STATE_pid = String(service.pid);
      process.env["STATE_process-group-id"] = String(
        service.identity.processGroupId,
      );
      process.env["STATE_process-start-time"] =
        service.identity.processStartTime;
      const savedPid = getState("pid");
      assert.equal(savedPid, String(service.pid));
      assert.equal(
        await terminateProcessGroup(savedPid, {
          processGroupId: getState("process-group-id"),
          processStartTime: getState("process-start-time"),
        }),
        true,
      );
      await waitForProcessExit(service.pid);
    } finally {
      if (service !== undefined) {
        await terminateProcessGroup(service.pid, service.identity);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans up a spawned process when state persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
    let service;

    try {
      process.env.GITHUB_STATE = directory;
      service = await spawnDetached({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 60_000)"],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
      });
      assert.equal(service.anchor.connected, true);

      await assert.rejects(() => persistProcessState(service));
      await waitForProcessExit(service.pid);
      await waitForProcessGroupExit(service.identity.processGroupId);
    } finally {
      if (service !== undefined) {
        await terminateProcessGroup(service.pid, service.identity);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a nonexistent command without leaving an anchor behind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
    let service;

    try {
      await assert.rejects(async () => {
        service = await spawnDetached({
          command: join(directory, "does-not-exist"),
          args: [],
          cwd: process.cwd(),
          env: process.env,
          logPath: join(directory, "service.log"),
        });
      });
    } finally {
      if (service !== undefined) {
        await terminateProcessGroup(service.pid, service.identity);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not signal a process group when its identity changed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
    let service;

    try {
      service = await spawnDetached({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 60_000)"],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
      });

      assert.equal(
        await terminateProcessGroup(service.pid, {
          processGroupId: service.identity.processGroupId,
          processStartTime: "not-the-start-time",
        }),
        false,
      );
      assert.doesNotThrow(() =>
        process.kill(-service.identity.processGroupId, 0),
      );
    } finally {
      if (service !== undefined) {
        await terminateProcessGroup(service.pid, service.identity);
        await waitForProcessExit(service.pid);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns false when the recorded leader is gone but its group remains", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
    const childPidPath = join(directory, "child.pid");
    let service;
    let childPid;

    try {
      service = await spawnDetached({
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
      });
      childPid = await waitForProcessId(childPidPath);
      process.kill(service.pid, "SIGKILL");
      await waitForProcessExit(service.pid);

      assert.equal(
        await terminateProcessGroup(service.pid, service.identity),
        false,
      );
      assert.doesNotThrow(() => process.kill(childPid, 0));
    } finally {
      if (service !== undefined) {
        try {
          process.kill(-service.identity.processGroupId, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH" && error?.code !== "EINVAL") throw error;
        }
      }
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills descendants after a SIGTERM-exiting leader leaves one resistant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
    const childPidPath = join(directory, "child.pid");
    let service;
    let childPid;

    try {
      service = await spawnDetached({
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
      });
      childPid = await waitForProcessId(childPidPath);
      assert.doesNotThrow(() => process.kill(childPid, 0));

      assert.equal(
        await terminateProcessGroup(service.pid, service.identity),
        true,
      );
      await waitForProcessExit(childPid);
    } finally {
      if (service !== undefined) {
        await terminateProcessGroup(service.pid, service.identity);
      }
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases failed HTTP readiness response bodies", async () => {
    const cancelled = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      body: {
        cancel: async () => {
          cancelled.push(true);
        },
      },
    });

    try {
      await assert.rejects(
        () => waitForHttpHealth("http://127.0.0.1:1", 1),
        /Service did not become ready/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(cancelled, [true]);
  });
});
