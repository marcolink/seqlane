// @test-scope ./effect-process.ts

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalProcessCancelledError,
  LocalProcessOutputLimitError,
  LocalProcessTimeoutError,
  runLocalProcess,
} from "./effect-process.js";

const cwd = process.cwd();
const PROCESS_EXIT_WAIT_MS = 1_000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 25;

function request(
  overrides: Partial<Parameters<typeof runLocalProcess>[0]> = {},
) {
  return {
    command: process.execPath,
    args: ["-e", ""],
    cwd,
    outputLimitBytes: 1024,
    taskId: "local-task",
    invocationId: "local-invocation",
    ...overrides,
  };
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const stateIndex = stat.lastIndexOf(")") + 2;
      return stat[stateIndex] !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessToExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await processIsAlive(pid))) {
      return true;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PROCESS_EXIT_POLL_INTERVAL_MS),
    );
  }
  return !(await processIsAlive(pid));
}

describe("Effect deterministic process integration", () => {
  it("uses Effect's scoped Node process with direct argv, cwd, and timing", async () => {
    const literalArgument = "$(not-a-shell); literal argument";
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-effect-process-"));
    try {
      const result = await runLocalProcess(
        request({
          cwd: workspace,
          args: [
            "-e",
            "process.stdout.write(`${process.cwd()}\\n${process.argv[1]}`); process.stderr.write('stderr')",
            literalArgument,
          ],
        }),
      );

      const canonicalWorkspace = await realpath(workspace);
      expect(result).toMatchObject({
        exitCode: 0,
        stderr: "stderr",
        taskId: "local-task",
        invocationId: "local-invocation",
        outcome: "completed",
        timedOut: false,
        cancelled: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      expect(result.stdout).toBe(`${canonicalWorkspace}\n${literalArgument}`);
      expect(result.startedAt).toEqual(expect.any(Number));
      expect(result.endedAt).toEqual(expect.any(Number));
      expect(result.durationMs).toEqual(expect.any(Number));
      expect(result.endedAt!).toBeGreaterThanOrEqual(result.startedAt!);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves non-zero exit status and independently bounds output", async () => {
    await expect(
      runLocalProcess(
        request({
          args: [
            "-e",
            "process.stdout.write('1234'); process.stderr.write('5678'); process.exit(23)",
          ],
          outputLimitBytes: 3,
        }),
      ),
    ).rejects.toMatchObject({
      name: LocalProcessOutputLimitError.name,
      result: {
        exitCode: 23,
        stdout: "234",
        stderr: "678",
        outcome: "completed",
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
  });

  it("normalizes timeout without treating it as cancellation", async () => {
    await expect(
      runLocalProcess(
        request({
          args: ["-e", "setTimeout(() => undefined, 1000)"],
          timeoutMs: 20,
        }),
      ),
    ).rejects.toMatchObject({
      name: LocalProcessTimeoutError.name,
      result: {
        exitCode: 124,
        outcome: "timed_out",
        timedOut: true,
        cancelled: false,
      },
    });
  });

  it("keeps bounded output emitted before a timeout", async () => {
    await expect(
      runLocalProcess(
        request({
          args: [
            "-e",
            "process.stdout.write('partial'); setInterval(() => undefined, 1000)",
          ],
          timeoutMs: 100,
        }),
      ),
    ).rejects.toMatchObject({
      name: LocalProcessTimeoutError.name,
      result: { stdout: "partial", stderr: "", stdoutTruncated: false },
    });
  });

  it("eventually terminates the timed-out process", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-effect-process-"));
    let pid: number | undefined;
    try {
      const pidPath = join(workspace, "pid");
      const result = runLocalProcess(
        request({
          cwd: workspace,
          timeoutMs: 1_000,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)",
            pidPath,
          ],
        }),
      );
      const settled = result.then(
        () => undefined,
        (cause) => cause,
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(pidPath, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }

      expect(await settled).toBeInstanceOf(LocalProcessTimeoutError);
      expect(pid).toEqual(expect.any(Number));
      expect(await waitForProcessToExit(pid!)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "terminates owned descendants without signaling a foreign process",
    async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "seqlane-effect-process-"),
      );
      const foreign = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      foreign.unref();
      const controller = new AbortController();
      const parentPidPath = join(workspace, "parent-pid");
      const childPidPath = join(workspace, "child-pid");
      const resultPromise = runLocalProcess(
        request({
          cwd: workspace,
          signal: controller.signal,
          args: [
            "-e",
            "const fs = require('node:fs'); const { spawn } = require('node:child_process'); fs.writeFileSync(process.argv[1], String(process.pid)); spawn(process.execPath, ['-e', \"require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)\", process.argv[2]], { stdio: 'ignore' }); setInterval(() => undefined, 1000)",
            parentPidPath,
            childPidPath,
          ],
        }),
      );
      try {
        let parentPid: number | undefined;
        let childPid: number | undefined;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            [parentPid, childPid] = await Promise.all([
              readFile(parentPidPath, "utf8").then(Number),
              readFile(childPidPath, "utf8").then(Number),
            ]);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
        expect(parentPid).toEqual(expect.any(Number));
        expect(childPid).toEqual(expect.any(Number));
        controller.abort("test cancellation");
        await expect(resultPromise).resolves.toMatchObject({ cancelled: true });
        expect(await waitForProcessToExit(parentPid!)).toBe(true);
        expect(await waitForProcessToExit(childPid!)).toBe(true);
        expect(foreign.pid).toEqual(expect.any(Number));
        expect(await processIsAlive(foreign.pid!)).toBe(true);
      } finally {
        controller.abort("test cleanup");
        await resultPromise.catch(() => undefined);
        if (foreign.pid !== undefined) {
          try {
            process.kill(-foreign.pid, "SIGTERM");
          } catch {
            // The foreign process may already have exited.
          }
        }
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("cancels and terminates the Local process before returning", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-effect-process-"));
    const controller = new AbortController();
    let pid: number | undefined;
    const resultPromise = runLocalProcess(
      request({
        cwd: workspace,
        signal: controller.signal,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)",
          join(workspace, "pid"),
        ],
      }),
    );
    try {
      const pidPath = join(workspace, "pid");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(pidPath, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
      controller.abort("test cancellation");
      await expect(resultPromise).resolves.toMatchObject({
        outcome: "cancelled",
        cancelled: true,
        timedOut: false,
      });
      expect(pid).toEqual(expect.any(Number));
      expect(await waitForProcessToExit(pid!)).toBe(true);
    } finally {
      await resultPromise.catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects cancellation before spawning a process", async () => {
    const controller = new AbortController();
    controller.abort("already cancelled");

    await expect(
      runLocalProcess(request({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(LocalProcessCancelledError);
  });
});
