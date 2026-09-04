// @test-scope ./mastra-process.ts

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MastraProcessCancelledError,
  MastraProcessResultError,
  normalizeMastraProcessResult,
  runMastraProcess,
} from "./mastra-process.js";

const cwd = process.cwd();

function request(
  overrides: Partial<Parameters<typeof runMastraProcess>[0]> = {},
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

describe("Mastra deterministic process integration", () => {
  it("uses Mastra's sandbox process with direct argv and normalizes identity and timing", async () => {
    const literalArgument = "$(not-a-shell); literal argument";
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-mastra-process-"));
    try {
      const result = await runMastraProcess(
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
    const result = await runMastraProcess(
      request({
        args: [
          "-e",
          "process.stdout.write('1234'); process.stderr.write('5678'); process.exit(23)",
        ],
        outputLimitBytes: 3,
      }),
    );

    expect(result).toMatchObject({
      exitCode: 23,
      stdout: "234",
      stderr: "678",
      outcome: "completed",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  });

  it("normalizes Mastra timeout without treating it as cancellation", async () => {
    const result = await runMastraProcess(
      request({
        args: ["-e", "setTimeout(() => undefined, 1000)"],
        timeoutMs: 20,
      }),
    );

    expect(result).toMatchObject({
      exitCode: 124,
      outcome: "timed_out",
      timedOut: true,
      cancelled: false,
    });
  });

  it("cancels and terminates the Mastra process before returning", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seqlane-mastra-process-"));
    const controller = new AbortController();
    let pid: number | undefined;
    const resultPromise = runMastraProcess(
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
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      await resultPromise.catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects malformed process results before they cross the Seqlane boundary", () => {
    expect(() =>
      normalizeMastraProcessResult(
        { exitCode: "0", stdout: "", stderr: "", executionTimeMs: 1 },
        request(),
        10,
        20,
      ),
    ).toThrow(MastraProcessResultError);
  });

  it("rejects cancellation before spawning a process", async () => {
    const controller = new AbortController();
    controller.abort("already cancelled");

    await expect(
      runMastraProcess(request({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(MastraProcessCancelledError);
  });
});
