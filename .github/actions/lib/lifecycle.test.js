import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getState,
  saveState,
  spawnDetached,
  terminateProcessGroup,
} from "./lifecycle.js";

const stateEnvironmentKeys = ["GITHUB_STATE", "STATE_pid", "STATE_PID"];

afterEach(() => {
  for (const key of stateEnvironmentKeys) {
    delete process.env[key];
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

describe("GitHub Actions lifecycle helpers", () => {
  it("reads the exact state key written by the main action", () => {
    process.env.STATE_pid = "saved-pid";
    process.env.STATE_PID = "different-pid";

    assert.equal(getState("pid"), "saved-pid");
  });

  it("passes the saved PID to post cleanup and stops the detached process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
    const statePath = join(directory, "state");
    let pid;

    try {
      process.env.GITHUB_STATE = statePath;
      pid = await spawnDetached({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 60_000)"],
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
      });
      await saveState("pid", String(pid));

      assert.match(await readFile(statePath, "utf8"), /^pid<<seqlane-action/m);

      process.env.STATE_pid = String(pid);
      const savedPid = getState("pid");
      assert.equal(savedPid, String(pid));
      assert.equal(await terminateProcessGroup(savedPid), true);
      await waitForProcessExit(pid);
    } finally {
      if (pid !== undefined) await terminateProcessGroup(pid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back to signaling a reused PID", async () => {
    const originalKill = process.kill;
    const calls = [];
    process.kill = (pid, signal) => {
      calls.push([pid, signal]);
      if (pid === -17 && signal === 0) return true;
      if (pid === -17 && signal === "SIGTERM") {
        const error = new Error("process group disappeared");
        error.code = "ESRCH";
        throw error;
      }
      throw new Error(`Unexpected signal target: ${pid}`);
    };

    try {
      assert.equal(await terminateProcessGroup(17), true);
    } finally {
      process.kill = originalKill;
    }

    assert.deepEqual(calls, [
      [-17, 0],
      [-17, "SIGTERM"],
    ]);
  });
});
