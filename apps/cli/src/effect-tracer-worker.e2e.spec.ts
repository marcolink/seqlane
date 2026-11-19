// @test-scope ./runner-client.ts
// @test-scope ./test-fixtures/effect-worker-test-support.ts
// @test-scope ./test-fixtures/effect-tracer-runner.ts
// @test-scope ./test-fixtures/effect-tracer-workflow.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/settle-run-program.ts
// @test-scope ../../../libs/runtime/src/runner/main.ts
// @test-scope ../../../libs/runtime/src/runner/run.ts
// @test-scope ../../../libs/runtime/src/runner/owned-process-registry.ts
// @test-scope ../../../libs/runtime/src/private/telemetry/run-scope.ts
// @test-scope ../../../libs/runtime/src/private/telemetry/collector.ts
// @test-scope ../../../libs/runtime/src/private/telemetry/canonical-metrics.ts
// @test-scope ../../../libs/runtime/src/private/telemetry/otlp-exporter.ts
// @test-scope ../../../libs/runtime/src/private/telemetry/otlp-projection.ts
// @test-scope ../../../libs/protocol/src/telemetry-span-snapshot.ts
// @test-scope ./run-execution.ts
// @test-scope ../../../libs/runtime/src/classifier/system-one-client.ts

import { Effect } from "effect";
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
import {
  createRunnerSupervision,
  launchRunner,
  spawnRunnerProcess,
  type RunnerChild,
} from "./runner-client.js";
import { decodeOwnedProcessAcknowledgement } from "@seqlane/protocol/private/owned-process";
import { withCliTelemetryEffect } from "@seqlane/runtime/private/telemetry";
import { encodeTraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import { telemetryConfigurationEnvironment } from "@seqlane/runtime/private/telemetry";
import { z } from "zod";
import { traceCarrierEnvironment } from "./trace-carrier-environment.js";
import { runCommandResultSchema } from "./cli-contracts.js";
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
const otlpSpanPayloadSchema = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              name: z.string(),
              traceId: z.string(),
              spanId: z.string(),
              parentSpanId: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
});
const otlpLogPayloadSchema = z.object({
  resourceLogs: z.array(
    z.object({
      scopeLogs: z.array(
        z.object({
          logRecords: z.array(
            z.object({
              body: z.object({ stringValue: z.string() }),
              traceId: z.string(),
              spanId: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
});
const otlpMetricPayloadSchema = z.object({
  resourceMetrics: z.array(
    z.object({
      scopeMetrics: z.array(
        z.object({
          metrics: z.array(
            z.object({
              name: z.string(),
              sum: z
                .object({
                  dataPoints: z.array(
                    z.object({
                      asInt: z.string().optional(),
                      attributes: z
                        .array(
                          z.object({
                            key: z.string(),
                            value: z.object({ stringValue: z.string() }),
                          }),
                        )
                        .optional(),
                    }),
                  ),
                })
                .optional(),
              gauge: z
                .object({
                  dataPoints: z.array(
                    z.object({ asInt: z.string().optional() }),
                  ),
                })
                .optional(),
            }),
          ),
        }),
      ),
    }),
  ),
});
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
    const tracePayloads: string[] = [];
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (
          incoming.url === "/v1/traces" ||
          incoming.url === "/v1/metrics" ||
          incoming.url === "/v1/logs"
        ) {
          if (incoming.url === "/v1/traces") tracePayloads.push(body);
          outgoing.writeHead(200, { "content-type": "application/json" });
          outgoing.end("{}");
          return;
        }
        requests += 1;
        expect(incoming.headers.authorization).toBe(
          "Bearer effect-classifier-secret",
        );
        expect(JSON.parse(body)).toMatchObject({
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
          [telemetryConfigurationEnvironment]: JSON.stringify({
            endpoint: `http://127.0.0.1:${address.port}`,
            payloadPolicy: "metadata",
          }),
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
      expect(tracePayloads).toHaveLength(1);
      const exportedSpans = otlpSpanPayloadSchema
        .parse(JSON.parse(tracePayloads[0]!))
        .resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        );
      const cliRun = exportedSpans.find(
        (span) => span.name === "seqlane.cli.run",
      );
      const workerRun = exportedSpans.find(
        (span) => span.name === "seqlane.worker.run",
      );
      const runtimeRun = exportedSpans.find(
        (span) => span.name === "seqlane.runtime.execution",
      );
      const classifierRun = exportedSpans.find(
        (span) => span.name === "seqlane.classifier.execute",
      );
      const invocationSpans = exportedSpans.filter(
        (span) => span.name === "seqlane.invocation",
      );
      expect(cliRun).toBeDefined();
      expect(workerRun).toBeDefined();
      expect(runtimeRun).toBeDefined();
      expect(classifierRun).toBeDefined();
      expect(invocationSpans).toHaveLength(3);
      expect(new Set(exportedSpans.map((span) => span.traceId))).toEqual(
        new Set([cliRun!.traceId]),
      );
      expect(workerRun?.parentSpanId).toBe(cliRun?.spanId);
      expect(runtimeRun?.parentSpanId).toBe(workerRun?.spanId);
      expect(
        invocationSpans.every(
          (span) => span.parentSpanId === runtimeRun?.spanId,
        ),
      ).toBe(true);
      expect(
        invocationSpans.some(
          (span) => span.spanId === classifierRun?.parentSpanId,
        ),
      ).toBe(true);
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
          expect(result).not.toHaveProperty("failure");
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

  it.each(["SIGINT", "SIGTERM"] as const)(
    "drains a pending ownership ACK before reporting %s cancellation",
    async (signal) => {
      events.length = 0;
      const signalSource = new EventEmitter();
      const child = spawnRunnerProcess({
        runnerPath,
        cwd: repositoryRoot,
      });
      let releaseAcknowledgement: (() => void) | undefined;
      let registered!: (pid: number) => void;
      const registration = new Promise<number>((resolve) => {
        registered = resolve;
      });
      const supervisedChild: RunnerChild = {
        pid: child.pid,
        on: child.on.bind(child),
        removeListener: child.removeListener.bind(child),
        kill: child.kill.bind(child),
        send(message, callback) {
          let acknowledgement;
          try {
            acknowledgement = decodeOwnedProcessAcknowledgement(message);
          } catch {
            return child.send(message, callback);
          }
          if (acknowledgement.action !== "register") {
            return child.send(message, callback);
          }
          // Hold the worker's ACK after the supervisor accepts its identity.
          releaseAcknowledgement = () => {
            if (child.connected) child.send(message);
          };
          callback?.(null);
          registered(acknowledgement.identity.pid);
          return true;
        },
      };
      const supervision = createRunnerSupervision(
        supervisedChild,
        request({ value: signal, mode: "hang" }),
        {
          signalSource,
          onExecutionEvent: (event) => events.push(event),
        },
      );
      let settled = false;
      void supervision.result.then(() => {
        settled = true;
      });
      try {
        const pid = await registration;
        expect(processIsAlive(pid)).toBe(true);
        signalSource.emit(signal);
        await waitForProcessExit(pid);
        // OS cleanup must complete while terminal delivery still waits for ACK.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
        expect(terminalEvents()).toEqual([]);
        releaseAcknowledgement?.();
        const result = await supervision.result;
        expect(result).not.toHaveProperty("failure");
        expect(result).toMatchObject({
          status: 130,
          terminalEvent: { type: "run.cancelled" },
          cancellationSignal: signal,
        });
        expect(processIsAlive(pid)).toBe(false);
        expect(terminalEvents()).toHaveLength(1);
      } finally {
        releaseAcknowledgement?.();
        await closeRunnerWorker({
          child,
          request: request({ value: signal, mode: "hang" }),
          result: supervision.result,
          cancel: supervision.cancel,
          close: supervision.cancel,
        });
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

  it("propagates the real CLI parent span into compiled worker events", async () => {
    const captured = await Effect.runPromise(
      withCliTelemetryEffect(({ carrier }) =>
        Effect.tryPromise({
          try: async () => {
            events.length = 0;
            const client = launchRunner(request({ value: "correlated" }), {
              runnerPath,
              cwd: repositoryRoot,
              environment: {
                ...process.env,
                [traceCarrierEnvironment]: encodeTraceCarrier(carrier),
              },
              onExecutionEvent: (event) => events.push(event),
            });
            try {
              return await client.result;
            } finally {
              client.close();
            }
          },
          catch: (cause) => cause,
        }),
      ),
    );
    const { value } = captured;
    const { spans } = captured.snapshot();

    expect(value).toMatchObject({
      status: 0,
      terminalEvent: { type: "run.succeeded" },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("seqlane.cli.run");
    expect(events.length).toBeGreaterThan(1);
    const carriers = new Set(events.map((event) => event.metadata.traceparent));
    expect(carriers.size).toBe(1);
    const carrier = [...carriers][0];
    expect(carrier).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const [, traceId, workerSpanId] = carrier!.split("-");
    expect(traceId).toBe(spans[0]?.traceId);
    expect(workerSpanId).not.toBe(spans[0]?.spanId);
  }, 30_000);

  it("exports correlated telemetry from the compiled Oclif run command", async () => {
    const batches: Array<{ path: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        batches.push({
          path: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Telemetry fixture server did not bind");
      const cli = startCompiledCli({
        cliRoot,
        args: [
          "run",
          `${workflowModule}#effectTracerWorkflow`,
          "--input",
          JSON.stringify({ value: "compiled-telemetry" }),
          "--json",
        ],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          [telemetryConfigurationEnvironment]: JSON.stringify({
            endpoint: `http://127.0.0.1:${address.port}`,
            payloadPolicy: "metadata",
          }),
        },
      });
      const result = await cli.completed;
      expect(result.code).toBe(0);
      const commandResult = runCommandResultSchema.parse(
        JSON.parse(result.stdout),
      );
      expect(commandResult.status).toBe("succeeded");
      if (commandResult.status === "succeeded")
        expect(commandResult.output).toEqual({
          value: "effect:compiled-telemetry",
        });
      const traces = batches.find((batch) => batch.path === "/v1/traces");
      const logs = batches.find((batch) => batch.path === "/v1/logs");
      const metrics = batches.find((batch) => batch.path === "/v1/metrics");
      expect(traces).toBeDefined();
      expect(logs).toBeDefined();
      expect(metrics).toBeDefined();
      const tracePayload = otlpSpanPayloadSchema.parse(
        JSON.parse(traces!.body),
      );
      const logPayload = otlpLogPayloadSchema.parse(JSON.parse(logs!.body));
      const metricPayload = otlpMetricPayloadSchema.parse(
        JSON.parse(metrics!.body),
      );
      const exportedSpans = tracePayload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      );
      const exportedLogs = logPayload.resourceLogs.flatMap((resource) =>
        resource.scopeLogs.flatMap((scope) => scope.logRecords),
      );
      const exportedMetrics = metricPayload.resourceMetrics.flatMap(
        (resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics),
      );
      const cliSpan = exportedSpans.find(
        (span) => span.name === "seqlane.cli.run",
      );
      const runStarted = exportedLogs.find(
        (log) => log.body.stringValue === "run.started",
      );
      expect(cliSpan).toBeDefined();
      expect(runStarted?.traceId).toBe(cliSpan?.traceId);
      expect(runStarted?.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(runStarted?.spanId).not.toBe(cliSpan?.spanId);
      const queuePeak = exportedMetrics.find(
        (metric) => metric.name === "seqlane.event_queue.pending_bytes_peak",
      );
      const queueCapacity = exportedMetrics.find(
        (metric) => metric.name === "seqlane.event_queue.capacity_bytes",
      );
      expect(Number(queuePeak?.gauge?.dataPoints[0]?.asInt)).toBeGreaterThan(0);
      expect(queueCapacity?.gauge?.dataPoints[0]?.asInt).toBe("16777216");
      expect(
        exportedMetrics.find(
          (metric) => metric.name === "seqlane.event_queue.capacity_waits",
        )?.sum?.dataPoints[0]?.asInt,
      ).toBe("0");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  it("exports a trace failure count without changing the successful CLI result", async () => {
    const batches: Array<{ path: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const path = request.url ?? "";
        batches.push({ path, body: Buffer.concat(chunks).toString("utf8") });
        response
          .writeHead(path === "/v1/traces" ? 503 : 200, {
            "content-type": "application/json",
          })
          .end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Telemetry fixture server did not bind");
      const cli = startCompiledCli({
        cliRoot,
        args: [
          "run",
          `${workflowModule}#effectTracerWorkflow`,
          "--input",
          JSON.stringify({ value: "export-failure" }),
          "--json",
        ],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          [telemetryConfigurationEnvironment]: JSON.stringify({
            endpoint: `http://127.0.0.1:${address.port}`,
            payloadPolicy: "metadata",
          }),
        },
      });
      const result = await cli.completed;
      expect(result.code).toBe(0);
      const commandResult = runCommandResultSchema.parse(
        JSON.parse(result.stdout),
      );
      expect(commandResult.status).toBe("succeeded");
      if (commandResult.status === "succeeded")
        expect(commandResult.output).toEqual({
          value: "effect:export-failure",
        });
      expect(result.stderr).toContain("seqlane telemetry export incomplete");
      expect(batches.map((batch) => batch.path)).toEqual([
        "/v1/traces",
        "/v1/logs",
        "/v1/metrics",
      ]);
      const metrics = batches.find((batch) => batch.path === "/v1/metrics");
      const metricPayload = otlpMetricPayloadSchema.parse(
        JSON.parse(metrics!.body),
      );
      const exportFailure = metricPayload.resourceMetrics
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .find((metric) => metric.name === "seqlane.telemetry.export_failures");
      expect(exportFailure?.sum?.dataPoints[0]?.asInt).toBe("1");
      expect(exportFailure?.sum?.dataPoints[0]?.attributes).toContainEqual({
        key: "signal",
        value: { stringValue: "traces" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);
});
