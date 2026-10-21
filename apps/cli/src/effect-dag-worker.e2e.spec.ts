// @test-scope ./commands/run.ts
// @test-scope ./runner-client.ts
// @test-scope ./test-fixtures/effect-dag-workflow.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/program.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/workflow-run.ts
// @test-scope ../../../libs/runtime/src/runtime/invocation/invocation-execution.ts
// @test-scope ../../../libs/runtime/src/runner/effect-tracer.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/settle-run-program.ts
// @test-scope ../../../libs/runtime/src/runner/main.ts
// @test-scope ../../../libs/runtime/src/runner/run.ts

import { once } from "node:events";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
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

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repositoryRoot, "apps/cli");
const compiledRunner = join(
  cliRoot,
  "dist/test-fixtures/effect-tracer-runner.js",
);
const graphModule = join(cliRoot, "dist/test-fixtures/effect-dag-workflow.js");
const graphWorkflowUrl = pathToFileURL(graphModule).href;
const failureWorkflowUrl = `${graphWorkflowUrl}#effectDagFailureWorkflow`;
const malformedWorkflowUrl = `${graphWorkflowUrl}#effectDagMalformedWorkflow`;
const graphExportUrl = `${graphWorkflowUrl}#effectDagWorkflow`;
let events: SeqlaneExecutionEvent[] = [];
let temporaryRoot: string;
let runnerPath: string;
let consumerRoot: string;

type WorkflowInput = "graph" | "failure" | "malformed";
type InvocationCreatedEvent = Extract<
  SeqlaneExecutionEvent,
  { readonly type: "invocation.created" }
>;

function request(input: unknown, workflow: WorkflowInput): RunRequest {
  const candidate: unknown = {
    type: "run.start",
    workflow: {
      id: `effect-v4-dependency-graph-${workflow}`,
      moduleSpecifier:
        workflow === "graph"
          ? graphWorkflowUrl
          : workflow === "failure"
            ? failureWorkflowUrl
            : malformedWorkflowUrl,
      exportName:
        workflow === "graph"
          ? "effectDagWorkflow"
          : workflow === "failure"
            ? "effectDagFailureWorkflow"
            : "effectDagMalformedWorkflow",
    },
    input,
    runtime: { id: "local" },
  };
  if (!isRunRequest(candidate)) {
    throw new TypeError("Effect DAG fixture input is not a valid run request");
  }
  return candidate;
}

function startWorker(input: unknown, workflow: WorkflowInput = "graph") {
  events = [];
  return launchRunner(request(input, workflow), {
    runnerPath,
    cwd: repositoryRoot,
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture marker ${path}`);
}

async function waitForEvent(
  predicate: (event: SeqlaneExecutionEvent) => boolean,
): Promise<SeqlaneExecutionEvent> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for runner event");
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
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function prepareExternalCli(): string {
  const destination = join(temporaryRoot, "consumer");
  mkdirSync(destination, { recursive: true });
  cpSync(join(cliRoot, "bin"), join(destination, "bin"), { recursive: true });
  cpSync(join(cliRoot, "dist"), join(destination, "dist"), {
    recursive: true,
  });
  cpSync(
    join(cliRoot, "oclif.config.mjs"),
    join(destination, "oclif.config.mjs"),
  );
  symlinkSync(join(cliRoot, "node_modules"), join(destination, "node_modules"));

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
  writeFileSync(join(destination, "package.json"), JSON.stringify(packageJson));
  return destination;
}

function markerDirectory(prefix: string): string {
  const path = mkdtempSync(join(temporaryRoot, prefix));
  return path;
}

function eventsForTask(
  eventType: "invocation.input" | "invocation.result",
  taskId: string,
): SeqlaneExecutionEvent[] {
  const invocationIds = new Set(
    events.flatMap((event) =>
      event.type === "invocation.created" && event.taskId === taskId
        ? [event.invocationId]
        : [],
    ),
  );
  return events.filter(
    (event) =>
      event.type === eventType && invocationIds.has(event.invocationId),
  );
}

function createdInvocation(taskId: string): InvocationCreatedEvent | undefined {
  return events.find(
    (event): event is InvocationCreatedEvent =>
      event.type === "invocation.created" && event.taskId === taskId,
  );
}

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-effect-dag-"));
  consumerRoot = prepareExternalCli();
  runnerPath = compiledRunner;
});

afterAll(() => {
  if (temporaryRoot !== undefined) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("Effect S2 dependency graph through the compiled CLI", () => {
  it("runs a fast successor while its independent slow prerequisite is active", async () => {
    const traceDir = markerDirectory("dag-cli-");
    const input = {
      traceDir,
      payload: { token: "preserve", nested: {} },
    };
    const child = spawn(
      process.execPath,
      [
        join(consumerRoot, "bin/run.js"),
        "run",
        graphExportUrl,
        "--input",
        JSON.stringify(input),
        "--json",
      ],
      {
        cwd: consumerRoot,
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = once(child, "close");
    try {
      await waitForFile(join(traceDir, "slow.started"));
      await waitForFile(join(traceDir, "successor.started"));
      expect(existsSync(join(traceDir, "slow.release"))).toBe(false);
      writeFileSync(join(traceDir, "slow.release"), "release");
      const [code] = await closed;

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        status: "succeeded",
        output: {
          payload: {
            token: { value: "normalized:preserve" },
            nested: { enabled: false, count: 0, empty: "" },
          },
          slow: "settled",
        },
      });
      expect(existsSync(join(traceDir, "join.started"))).toBe(true);
      expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        writeFileSync(join(traceDir, "slow.release"), "release");
        child.kill("SIGTERM");
        await Promise.race([
          closed,
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    }
  }, 30_000);

  it("bridges task bindings and emits one terminal after joined work settles", async () => {
    const traceDir = markerDirectory("dag-worker-");
    const client = startWorker({
      traceDir,
      payload: { token: "exact", nested: {} },
    });
    try {
      await waitForFile(join(traceDir, "slow.started"));
      await waitForFile(join(traceDir, "successor.started"));
      expect(existsSync(join(traceDir, "slow.release"))).toBe(false);
      expect(existsSync(join(traceDir, "join.started"))).toBe(false);
      writeFileSync(join(traceDir, "slow.release"), "release");
      const result = await client.result;

      expect(result.status).toBe(0);
      if (result.status !== 0) throw new Error("Expected a successful run");
      expect(result.terminalEvent.output).toEqual({
        payload: {
          token: { value: "normalized:exact" },
          nested: { enabled: false, count: 0, empty: "" },
        },
        slow: "settled",
      });
      expect(
        eventsForTask("invocation.input", "effect-dag-fast"),
      ).toContainEqual(
        expect.objectContaining({
          input: {
            state: "present",
            value: {
              traceDir,
              payload: {
                token: { value: "normalized:exact" },
                nested: { enabled: false, count: 0, empty: "" },
              },
            },
          },
        }),
      );
      expect(
        eventsForTask("invocation.input", "effect-dag-fast-successor"),
      ).toContainEqual(
        expect.objectContaining({
          input: {
            state: "present",
            value: {
              traceDir,
              payload: {
                token: { value: "normalized:exact" },
                nested: { enabled: false, count: 0, empty: "" },
              },
            },
          },
        }),
      );
      expect(
        eventsForTask("invocation.result", "effect-dag-fast"),
      ).toContainEqual(
        expect.objectContaining({
          result: {
            state: "present",
            value: {
              token: { value: "normalized:exact" },
              nested: { enabled: false, count: 0, empty: "" },
            },
          },
        }),
      );
      expect(
        eventsForTask("invocation.input", "effect-dag-join"),
      ).toContainEqual(
        expect.objectContaining({
          input: {
            state: "present",
            value: {
              traceDir,
              payload: {
                token: { value: "normalized:exact" },
                nested: { enabled: false, count: 0, empty: "" },
              },
              slow: "settled",
            },
          },
        }),
      );
      expect(terminalEvents()).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("run.succeeded");
      expect(existsSync(join(traceDir, "slow.settled"))).toBe(true);
      expect(
        events.filter(
          (event) =>
            event.type === "invocation.created" &&
            event.taskId === "effect-dag-join",
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === "invocation.started" &&
            event.taskId === "effect-dag-join",
        ),
      ).toHaveLength(1);
      expect(events.map((event) => event.metadata.sequence)).toEqual(
        events.map((_, index) => index + 1),
      );
    } finally {
      writeFileSync(join(traceDir, "slow.release"), "release");
      await closeWorker(client);
    }
  }, 30_000);

  it("rejects malformed task input before its body starts", async () => {
    const traceDir = markerDirectory("dag-malformed-");
    const client = startWorker({ traceDir }, "malformed");
    try {
      const result = await client.result;
      expect(result.status).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "run.failed",
          error: expect.objectContaining({
            category: "InputValidationError",
            taskId: "effect-dag-malformed-target",
          }),
        }),
      );
      const target = createdInvocation("effect-dag-malformed-target");
      expect(target).toBeDefined();
      expect(target?.planNodeId).toBe("effect-dag-malformed-target:1");
      expect(
        events.some(
          (event) =>
            event.type === "invocation.started" &&
            target !== undefined &&
            event.invocationId === target.invocationId,
        ),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "invocation.input" &&
            target !== undefined &&
            event.invocationId === target.invocationId,
        ),
      ).toBe(false);
      expect(existsSync(join(traceDir, "body-ran"))).toBe(false);
      expect(terminalEvents()).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("run.failed");
    } finally {
      await closeWorker(client);
    }
  }, 30_000);

  it("skips failed dependents and waits for independent accepted work", async () => {
    const traceDir = markerDirectory("dag-failure-");
    const client = startWorker({ traceDir }, "failure");
    try {
      await waitForFile(join(traceDir, "independent.started"));
      const failing = createdInvocation("effect-dag-failing-dependency");
      const dependent = createdInvocation("effect-dag-skipped-dependent");
      expect(failing).toBeDefined();
      expect(dependent).toBeDefined();
      expect(failing?.planNodeId).toBe("effect-dag-failing-dependency:1");
      expect(dependent?.planNodeId).toBe("effect-dag-skipped-dependent:1");
      if (failing === undefined) throw new Error("Failure invocation missing");
      await waitForEvent(
        (event) =>
          event.type === "invocation.failed" &&
          event.invocationId === failing.invocationId,
      );
      writeFileSync(join(traceDir, "independent.release"), "release");
      const result = await client.result;

      expect(result.status).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.skipped",
          invocationId: dependent?.invocationId,
          dependencyIds: [failing?.invocationId],
          reason: "dependency failed",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.failed",
          invocationId: failing.invocationId,
          disposition: "fail_run",
        }),
      );
      expect(existsSync(join(traceDir, "dependent.started"))).toBe(false);
      expect(existsSync(join(traceDir, "independent.settled"))).toBe(true);
      const independent = createdInvocation(
        "effect-dag-independent-active-work",
      );
      expect(independent).toBeDefined();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.succeeded",
          invocationId: independent?.invocationId,
        }),
      );
      expect(terminalEvents()).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("run.failed");
      const lastInvocationSettlement = events.reduce(
        (last, event, index) =>
          event.type === "invocation.succeeded" ||
          event.type === "invocation.failed" ||
          event.type === "invocation.skipped" ||
          event.type === "invocation.cancelled"
            ? index
            : last,
        -1,
      );
      expect(
        events.findIndex((event) => event.type === "run.failed"),
      ).toBeGreaterThan(lastInvocationSettlement);
    } finally {
      writeFileSync(join(traceDir, "independent.release"), "release");
      await closeWorker(client);
    }
  }, 30_000);
});
