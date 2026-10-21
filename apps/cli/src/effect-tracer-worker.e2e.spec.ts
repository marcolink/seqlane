// @test-scope ./runner-client.ts
// @test-scope ./test-fixtures/effect-tracer-runner.ts
// @test-scope ./test-fixtures/effect-tracer-workflow.ts
// @test-scope ../../../libs/runtime/src/runner/effect-tracer.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/settle-run-program.ts
// @test-scope ../../../libs/runtime/src/runner/main.ts
// @test-scope ../../../libs/runtime/src/runner/run.ts

import { once } from "node:events";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isRunRequest,
  type RunRequest,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { launchRunner } from "./runner-client.js";
import type { RunnerSignalSource } from "./runner-client.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repositoryRoot, "apps/cli");
const compiledRunner = join(
  cliRoot,
  "dist/test-fixtures/effect-tracer-runner.js",
);
const workflowModule = join(
  cliRoot,
  "dist/test-fixtures/effect-tracer-workflow.js",
);
const workflowUrl = pathToFileURL(workflowModule).href;
const events: SeqlaneExecutionEvent[] = [];
let runnerPath: string;
let temporaryRoot: string;

function request(input: unknown): RunRequest {
  const candidate: unknown = {
    type: "run.start",
    workflow: {
      id: "effect-tracer-worker-fixture",
      moduleSpecifier: workflowUrl,
      exportName: "effectTracerWorkflow",
    },
    input,
    runtime: { id: "local" },
  };
  if (!isRunRequest(candidate)) {
    throw new TypeError(
      "Effect tracer worker input is not a valid run request",
    );
  }
  return candidate;
}

function startWorker(
  input: unknown,
  signalSource: RunnerSignalSource | null = null,
) {
  events.length = 0;
  return launchRunner(request(input), {
    runnerPath,
    cwd: repositoryRoot,
    signalSource,
    onExecutionEvent: (event) => events.push(event),
  });
}

function terminalEvents(): SeqlaneExecutionEvent[] {
  return events.filter(
    (event) =>
      event.type === "run.succeeded" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled",
  );
}

function invocationTerminalEvents(): SeqlaneExecutionEvent[] {
  return events.filter(
    (event) =>
      event.type === "invocation.succeeded" ||
      event.type === "invocation.failed" ||
      event.type === "invocation.cancelled",
  );
}

async function waitForProcessStart(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);
      expect(processIsAlive(pid)).toBe(true);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Local process did not write its pid marker");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Owned process ${pid} is still alive`);
}

async function closeWorker(
  client: ReturnType<typeof startWorker>,
): Promise<void> {
  if (client.child.exitCode !== null || client.child.signalCode !== null)
    return;
  const exited = once(client.child, "exit");
  client.close();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Runner worker did not exit")),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

beforeAll(() => {
  runnerPath = compiledRunner;
});

afterAll(() => {
  if (temporaryRoot !== undefined) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("Effect S1 runner worker", () => {
  it("runs the compiled Oclif command through the injected Effect worker", async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-effect-cli-"));
    cpSync(join(cliRoot, "bin"), join(temporaryRoot, "bin"), {
      recursive: true,
    });
    cpSync(join(cliRoot, "dist"), join(temporaryRoot, "dist"), {
      recursive: true,
    });
    cpSync(
      join(cliRoot, "oclif.config.mjs"),
      join(temporaryRoot, "oclif.config.mjs"),
    );
    symlinkSync(
      join(cliRoot, "node_modules"),
      join(temporaryRoot, "node_modules"),
    );
    const packageJson = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")));
    const exports = z
      .record(z.string(), z.record(z.string(), z.string()))
      .parse(packageJson["exports"]);
    exports["./runner"] = {
      types: "./dist/runner.d.ts",
      import: "./dist/test-fixtures/effect-tracer-runner.js",
      default: "./dist/test-fixtures/effect-tracer-runner.js",
    };
    packageJson["exports"] = exports;
    writeFileSync(
      join(temporaryRoot, "package.json"),
      JSON.stringify(packageJson),
    );

    const child = spawn(
      process.execPath,
      [
        join(temporaryRoot, "bin/run.js"),
        "run",
        workflowUrl + "#effectTracerWorkflow",
        "--input",
        JSON.stringify({ value: "compiled-cli" }),
        "--json",
      ],
      { cwd: temporaryRoot, env: { ...process.env, FORCE_COLOR: "0" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, "close");

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      status: "succeeded",
      output: { value: "effect:compiled-cli" },
    });
    expect(existsSync(join(temporaryRoot, ".seqlane"))).toBe(false);
  }, 30_000);

  it("bridges the exact task output and one ordered terminal event", async () => {
    const result = await startWorker({ value: "hello" }).result;

    expect(result).toMatchObject({
      status: 0,
      terminalEvent: {
        type: "run.succeeded",
        output: { value: "effect:hello" },
      },
    });
    expect(terminalEvents()).toHaveLength(1);
    expect(events.map((event) => event.metadata.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    const progressEvents = events.filter(
      (event) => event.type === "invocation.progress",
    );
    expect(
      progressEvents.map(({ state, phase }) => ({ state, phase })),
    ).toEqual([
      { state: "active", phase: "workspace_admitted" },
      { state: "active", phase: "execute" },
      { state: "active", phase: "workspace_released" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.plan",
      "invocation.created",
      "invocation.progress",
      "invocation.started",
      "invocation.progress",
      "invocation.output",
      "invocation.input",
      "invocation.result",
      "invocation.succeeded",
      "invocation.output",
      "invocation.progress",
      "run.succeeded",
    ]);
  });

  it.each([
    [{ value: "failure", mode: "failure" }, "ExecutorError"],
    [{ mode: "success" }, "InputValidationError"],
    [{ value: "" }, "InputValidationError"],
    [
      { value: "bad-task", mode: "malformed-task-output" },
      "OutputValidationError",
    ],
    [
      { value: "bad-workflow", mode: "malformed-workflow-output" },
      "OutputValidationError",
    ],
  ] as const)("reports validated failure for %j", async (input, category) => {
    const result = await startWorker(input).result;

    expect(result).toMatchObject({
      status: 1,
      terminalEvent: {
        type: "run.failed",
        error: { category },
      },
    });
    expect(terminalEvents()).toHaveLength(1);
    if (
      category === "InputValidationError" &&
      "value" in input &&
      input.value === ""
    ) {
      expect(events.map((event) => event.type)).toEqual([
        "run.started",
        "run.plan",
        "invocation.created",
        "invocation.failed",
        "run.failed",
      ]);
    } else {
      expect(invocationTerminalEvents()).toHaveLength(
        events.filter((event) => event.type === "invocation.created").length,
      );
    }
    if ("value" in input && input.value === "bad-workflow") {
      expect(events.map((event) => event.type)).toContain(
        "invocation.succeeded",
      );
      expect(invocationTerminalEvents()).toHaveLength(1);
    }
  });

  it("times out and confirms the worker-owned process has exited", async () => {
    const markerDirectory = mkdtempSync(join(tmpdir(), "seqlane-timeout-"));
    const pidFile = join(markerDirectory, "pid");
    try {
      const client = startWorker({
        value: "timeout",
        mode: "hang",
        timeoutMs: 1_000,
        pidFile,
      });
      let pid: number | undefined;
      try {
        pid = await waitForProcessStart(pidFile);
        const result = await client.result;

        expect(result.status).toBe(1);
        expect(processIsAlive(pid)).toBe(false);
        expect(result).toMatchObject({
          status: 1,
          terminalEvent: {
            type: "run.failed",
            error: { category: "ExecutorError" },
          },
        });
        expect(terminalEvents()).toHaveLength(1);
        await waitForProcessExit(pid);
      } finally {
        await closeWorker(client);
        if (pid !== undefined) await waitForProcessExit(pid);
      }
    } finally {
      rmSync(markerDirectory, { recursive: true, force: true });
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "waits for the process cleanup before reporting %s cancellation",
    async (signal) => {
      const markerDirectory = mkdtempSync(join(tmpdir(), "seqlane-signal-"));
      const pidFile = join(markerDirectory, "pid");
      try {
        const signalSource = new EventEmitter() as EventEmitter &
          RunnerSignalSource;
        const client = startWorker(
          {
            value: signal,
            mode: "hang",
            pidFile,
          },
          signalSource,
        );
        let pid: number | undefined;
        try {
          pid = await waitForProcessStart(pidFile);
          signalSource.emit(signal);

          const result = await client.result;
          expect(result.status).toBe(130);
          expect(processIsAlive(pid)).toBe(false);
          expect(result).toMatchObject({
            status: 130,
            terminalEvent: { type: "run.cancelled" },
          });
          expect(terminalEvents()).toHaveLength(1);
          await waitForProcessExit(pid);
        } finally {
          await closeWorker(client);
          if (pid !== undefined) await waitForProcessExit(pid);
        }
      } finally {
        rmSync(markerDirectory, { recursive: true, force: true });
      }
    },
  );

  it("settles worker cleanup when the supervising IPC channel disconnects", async () => {
    const markerDirectory = mkdtempSync(join(tmpdir(), "seqlane-disconnect-"));
    const pidFile = join(markerDirectory, "pid");
    try {
      const client = startWorker({
        value: "disconnect",
        mode: "hang",
        pidFile,
      });
      let pid: number | undefined;
      try {
        pid = await waitForProcessStart(pidFile);
        const exited = once(client.child, "exit");
        client.child.disconnect();

        const [code] = await exited;
        expect(code).not.toBeNull();
        await expect(client.result).resolves.toMatchObject({ status: 1 });
        expect(processIsAlive(pid)).toBe(false);
        await waitForProcessExit(pid);
      } finally {
        await closeWorker(client);
        if (pid !== undefined) await waitForProcessExit(pid);
      }
    } finally {
      rmSync(markerDirectory, { recursive: true, force: true });
    }
  });
});
