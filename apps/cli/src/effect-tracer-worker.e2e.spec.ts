// @test-scope ./runner-client.ts
// @test-scope ./test-fixtures/effect-worker-test-support.ts
// @test-scope ./test-fixtures/effect-tracer-runner.ts
// @test-scope ./test-fixtures/effect-tracer-workflow.ts
// @test-scope ../../../libs/runtime/src/runner/effect-tracer.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/settle-run-program.ts
// @test-scope ../../../libs/runtime/src/runner/main.ts
// @test-scope ../../../libs/runtime/src/runner/run.ts
// @test-scope ../../../libs/runtime/src/classifier/system-one-client.ts

import { EventEmitter } from "node:events";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCompiledCli } from "./test-fixtures/effect-worker-test-support.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isRunRequest,
  type RunRequest,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { launchRunner } from "./runner-client.js";
import type { RunnerSignalSource } from "./runner-client.js";
import {
  closeRunnerWorker,
  prepareExternalCli,
} from "./test-fixtures/effect-worker-test-support.js";

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

beforeAll(() => {
  runnerPath = compiledRunner;
});

afterAll(() => {
  if (temporaryRoot !== undefined) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("Effect S1 runner worker", () => {
  it("runs classifier preparation and deterministic consumption through the compiled Effect CLI", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "seqlane-effect-classifier-"),
    );
    prepareExternalCli({
      cliRoot,
      destination: temporaryRoot,
      runnerEntrypoint: "./dist/test-fixtures/effect-tracer-runner.js",
    });
    let requests = 0;
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        requests += 1;
        expect(incoming.headers.authorization).toBe(
          "Bearer effect-classifier-secret",
        );
        expect(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        ).toMatchObject({
          state: { diff: "prepared:compiled effect diff" },
          questions: {
            area: { type: "choice" },
            priority: { type: "score" },
            needsReview: { type: "noul" },
          },
        });
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              area: {
                type: "choice",
                choice: "runtime",
                probabilities: { runtime: 0.8, docs: 0.2 },
                confidence: 0.8,
              },
              priority: {
                type: "score",
                score: 0.8,
                legend: { "0": "Low", "1": "High" },
                probabilities: { "0": 0.2, "1": 0.8 },
                confidence: 0.8,
              },
              needsReview: { type: "noul", noul: 0.63 },
            },
            usage: { input_tokens: 14, output_tokens: 7 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Classifier fixture did not bind a TCP port");
    try {
      const invocation = startCompiledCli({
        cliRoot: temporaryRoot,
        args: [
          "run",
          `${workflowUrl}#effectClassifierWorkflow`,
          "--input",
          JSON.stringify({ diff: "compiled effect diff" }),
          "--classifier-url",
          `http://127.0.0.1:${address.port}/v1/systemone`,
          "--classifier-model",
          "jev-latest",
          "--json",
        ],
        cwd: temporaryRoot,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          SEQLANE_CLASSIFIER_API_KEY: "effect-classifier-secret",
        },
      });
      const { code, stdout, stderr } = await invocation.completed;
      expect(code, stdout + stderr).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        status: "succeeded",
        output: { area: "runtime", priority: 0.8, reviewRequired: true },
      });
      expect(requests).toBe(1);
      expect(stdout + stderr).not.toContain("effect-classifier-secret");
      expect(existsSync(join(temporaryRoot, ".seqlane"))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs the compiled Oclif command through the injected Effect worker", async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-effect-cli-"));
    prepareExternalCli({
      cliRoot,
      destination: temporaryRoot,
      runnerEntrypoint: "./dist/test-fixtures/effect-tracer-runner.js",
    });

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
        await closeRunnerWorker(client, 3_000);
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
          await closeRunnerWorker(client, 3_000);
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
        await closeRunnerWorker(client, 3_000);
        if (pid !== undefined) await waitForProcessExit(pid);
      }
    } finally {
      rmSync(markerDirectory, { recursive: true, force: true });
    }
  });
});
