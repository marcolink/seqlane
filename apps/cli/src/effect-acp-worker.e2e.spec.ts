// @test-scope ./commands/run.ts
// @test-scope ./run-execution.ts
// @test-scope ./runner-client.ts
// @test-scope ./cli-contracts.ts
// @test-scope ./test-fixtures/effect-worker-test-support.ts
// @test-scope ./test-fixtures/effect-acp-runner.ts
// @test-scope ./test-fixtures/effect-acp-server.ts
// @test-scope ./test-fixtures/effect-acp-workflow.ts
// @test-scope ../../../libs/acp/src/adapter.ts
// @test-scope ../../../libs/acp/src/runtime.ts
// @test-scope ../../../libs/acp/src/stream.ts
// @test-scope ../../../libs/acp/src/transport.ts
// @test-scope ../../../libs/runtime/src/runner/main.ts
// @test-scope ../../../libs/runtime/src/runner/profile/runtime-profile.ts
// @test-scope ../../../libs/runtime/src/runtime/session/session-preflight.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import { runCommandResultSchema } from "./cli-contracts.js";
import {
  closeRunnerWorker,
  prepareExternalCli,
  startCompiledCli,
} from "./test-fixtures/effect-worker-test-support.js";

const cliRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerPath = join(cliRoot, "dist/test-fixtures/effect-acp-runner.js");
const serverPath = join(cliRoot, "dist/test-fixtures/effect-acp-server.js");
const workflowUrl = pathToFileURL(
  join(cliRoot, "dist/test-fixtures/effect-acp-workflow.js"),
).href;
const traceEventSchema = z.object({
  event: z.string(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  pid: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  persistSession: z.boolean().optional(),
  sessionId: z.string().optional(),
  result: z.unknown().optional(),
});
const correlationSchema = z.object({
  configId: z.string().optional(),
  value: z.string().optional(),
});
const processSchema = z.object({ pid: z.number().int().positive() });
const output = { done: false, count: 0, text: "", items: [""] };
const toolInput = {
  enabled: false,
  count: 0,
  text: "",
  nested: { items: [""] },
};
const toolOutput = {
  content: [{ type: "text", text: "fixture tool output" }],
  structuredContent: output,
};
const toolContent = [
  {
    type: "content",
    content: { type: "text", text: "initial fixture tool content" },
  },
];
const toolLocations = [{ path: "/fixture/result.json", line: 1 }];

let temporaryRoot: string;
let consumerRoot: string;

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-effect-acp-"));
  consumerRoot = realpathSync(
    prepareExternalCli({
      cliRoot,
      destination: join(temporaryRoot, "consumer"),
      runnerEntrypoint: "./dist/test-fixtures/effect-acp-runner.js",
    }),
  );
});

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function traceEvents(tracePath: string) {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => traceEventSchema.parse(JSON.parse(line)));
}

function fixtureEnvironment(
  tracePath: string,
  mode: "success" | "hold" | "permission" | "missing-model",
  persist = false,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: "0",
    SEQLANE_ACP_FIXTURE_MODE: mode,
    SEQLANE_ACP_FIXTURE_TRACE: tracePath,
    SEQLANE_ACP_FIXTURE_SERVER: serverPath,
    SEQLANE_ACP_FIXTURE_PERSIST: String(persist),
  };
}

function request(exportName: string): RunRequest {
  const workflowIds: Record<string, string> = {
    effectAcpReuseWorkflow: "effect-acp-reuse-cli-fixture",
    effectAcpForkWorkflow: "effect-acp-fork-cli-fixture",
    effectAcpUnsupportedModelWorkflow:
      "effect-acp-unsupported-model-cli-fixture",
    effectAcpSingleWorkflow: "effect-acp-single-cli-fixture",
  };
  const workflowId = workflowIds[exportName];
  if (workflowId === undefined) throw new Error("Unknown ACP fixture workflow");
  const value: unknown = {
    type: "run.start",
    workflow: {
      id: workflowId,
      moduleSpecifier: workflowUrl,
      exportName,
    },
    input: { value: "fixture" },
    runtime: { id: "direct-runtime", workspace: consumerRoot },
  };
  if (!isRunRequest(value)) throw new Error("Invalid ACP fixture run request");
  return value;
}

function isProcessDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ESRCH"
    ) {
      return true;
    }
    throw cause;
  }
}

function expectPeerClosed(tracePath: string): void {
  const events = traceEvents(tracePath);
  const start = events.find((event) => event.event === "process.started");
  expect(start).toBeDefined();
  expect(events.at(-1)?.event).toBe("process.closed");
  expect(isProcessDead(processSchema.parse(start).pid)).toBe(true);
}

function runCli(
  tracePath: string,
  mode: "success" | "permission" | "missing-model",
  exportName: string,
) {
  // Select the agent profile so the private test runner export can supply ACP.
  const invocation = startCompiledCli({
    cliRoot: consumerRoot,
    args: [
      "run",
      `${workflowUrl}#${exportName}`,
      "--input",
      '{"value":"fixture"}',
      "--workspace",
      consumerRoot,
      "--adapter",
      "codex",
      "--json",
    ],
    cwd: consumerRoot,
    env: fixtureEnvironment(tracePath, mode, mode === "success"),
  });
  return invocation.completed.then((result) => {
    return {
      code: result.code,
      stderr: result.stderr,
      result: runCommandResultSchema.parse(JSON.parse(result.stdout)),
    };
  });
}

function readJsonRpcMethods(tracePath: string): string[] {
  return traceEvents(tracePath)
    .map((event) => event.event)
    .filter((event) =>
      [
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/prompt",
        "session/cancel",
        "session/close",
        "session/request_permission",
      ].includes(event),
    );
}

async function waitFor(
  predicate: () => boolean,
  details: () => unknown,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ACP fixture: ${JSON.stringify(details())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Effect ACP compiled CLI and worker IPC", () => {
  it("runs persistent source and reuse tasks through compiled Oclif", async () => {
    const tracePath = join(temporaryRoot, "cli-success.jsonl");
    const result = await runCli(tracePath, "success", "effectAcpReuseWorkflow");
    expect(result.code, JSON.stringify(result)).toBe(0);
    expect(result.result).toMatchObject({ status: "succeeded", output });
    expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);

    const events = traceEvents(tracePath);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "process.started",
        cwd: consumerRoot,
        persistSession: true,
      }),
    );
    expect(events.find(({ event }) => event === "session.created")?.cwd).toBe(
      consumerRoot,
    );
    expect(events.filter(({ event }) => event === "session/new")).toHaveLength(
      1,
    );
    expect(
      events.filter(({ event }) => event === "session/set_config_option"),
    ).toHaveLength(1);
    expect(
      events.filter(({ event }) => event === "session/prompt"),
    ).toHaveLength(2);
    const selectedModel = events.find(
      ({ event }) => event === "session/set_config_option",
    );
    expect(correlationSchema.parse(selectedModel?.params)).toMatchObject({
      configId: "model",
      value: "fixture-model",
    });
    expect(events.at(-1)?.event).toBe("process.closed");
  }, 30_000);

  it("keeps ACP tool envelopes and native usage metadata complete over worker IPC", async () => {
    const tracePath = join(temporaryRoot, "ipc-success.jsonl");
    const events: SeqlaneExecutionEvent[] = [];
    let processDeadAtTerminal = false;
    const client = launchRunner(request("effectAcpSingleWorkflow"), {
      runnerPath,
      cwd: consumerRoot,
      environment: fixtureEnvironment(tracePath, "success"),
      signalSource: null,
      onExecutionEvent: (event) => {
        events.push(event);
        if (event.type !== "run.succeeded" && event.type !== "run.failed")
          return;
        const start = traceEvents(tracePath).find(
          (traceEvent) => traceEvent.event === "process.started",
        );
        if (start !== undefined) {
          processDeadAtTerminal = isProcessDead(processSchema.parse(start).pid);
        }
      },
    });
    const cancellationTimeout = setTimeout(() => client.cancel(), 15_000);
    try {
      const result = await client.result;
      expect(result.status, JSON.stringify({ result, events })).toBe(0);
      expect(events.map((event) => event.metadata.sequence)).toEqual(
        events.map((_, index) => index + 1),
      );
      expect(events.at(-1)?.type).toBe("run.succeeded");
      expect(
        events.filter((event) => event.type === "run.succeeded"),
      ).toHaveLength(1);

      const activities = events.filter(
        (event) =>
          event.type === "invocation.activity" &&
          event.kind === "tool" &&
          event.state === "succeeded",
      );
      expect(activities).toHaveLength(1);
      for (const activity of activities) {
        if (activity.type !== "invocation.activity") continue;
        expect(activity.input).toEqual({ state: "present", value: toolInput });
        expect(activity.output).toEqual({
          state: "present",
          value: toolOutput,
        });
        expect(activity.activityMetadata).toMatchObject({
          state: "present",
          value: {
            snapshot: {
              name: "fixture.echo",
              title: "Fixture activity",
              rawInput: toolInput,
              rawOutput: toolOutput,
              content: toolContent,
              locations: toolLocations,
              _meta: { fixture: { result: "complete", count: 0 } },
            },
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: activity.activityId,
              status: "completed",
              rawOutput: toolOutput,
              _meta: { fixture: { result: "complete", count: 0 } },
            },
            notification: {
              sessionId: "fixture-session-1",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: activity.activityId,
                status: "completed",
                rawOutput: toolOutput,
                _meta: { fixture: { result: "complete", count: 0 } },
              },
              _meta: {
                fixtureNotice: { terminal: false, count: 0, text: "" },
              },
            },
          },
        });
      }

      const usageObservation = events.find(
        (event) =>
          event.type === "invocation.observation" &&
          event.model.operation === "acp.session.usage",
      );
      expect(usageObservation?.type).toBe("invocation.observation");
      if (usageObservation?.type !== "invocation.observation")
        throw new Error("Missing native ACP usage observation");
      expect(usageObservation.model.usage).toMatchObject({
        sessionId: "fixture-session-1",
        update: {
          sessionUpdate: "usage_update",
          used: 0,
          size: 0,
          cost: {
            amount: 0,
            currency: "USD",
            _meta: { fixture: { billed: false, count: 0, text: "" } },
          },
          _meta: { fixture: { occupancy: 0, cumulative: true } },
        },
        _meta: {
          fixtureNotice: { usage: false, count: 0, text: "" },
        },
      });
      expect(usageObservation.model.cost).toBeUndefined();
      expect(usageObservation.availability).toContainEqual({
        path: "model.cost",
        reason: "source-unavailable",
      });
      expect(usageObservation.availability).toContainEqual({
        path: "model.model",
        reason: "source-unavailable",
      });
      expect(usageObservation.availability).toContainEqual({
        path: "model.provider",
        reason: "source-unavailable",
      });

      const records = traceEvents(tracePath);
      const start = records.find(({ event }) => event === "process.started");
      expect(start).toBeDefined();
      expect(start?.persistSession).toBe(false);
      const { pid } = processSchema.parse(start);
      expect(isProcessDead(pid)).toBe(true);
      expect(processDeadAtTerminal).toBe(true);
      expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
      expect(records.at(-1)?.event).toBe("process.closed");
      expect(readJsonRpcMethods(tracePath)).toContain("session/close");
    } finally {
      clearTimeout(cancellationTimeout);
      await closeRunnerWorker(client);
    }
  }, 30_000);

  it("cancels after ACP tool activity starts and confirms process cleanup", async () => {
    const tracePath = join(temporaryRoot, "ipc-cancel.jsonl");
    const events: SeqlaneExecutionEvent[] = [];
    let processDeadAtTerminal = false;
    const client = launchRunner(request("effectAcpSingleWorkflow"), {
      runnerPath,
      cwd: consumerRoot,
      environment: fixtureEnvironment(tracePath, "hold"),
      signalSource: null,
      onExecutionEvent: (event) => {
        events.push(event);
        if (event.type !== "run.cancelled") return;
        const start = traceEvents(tracePath).find(
          (traceEvent) => traceEvent.event === "process.started",
        );
        if (start !== undefined) {
          processDeadAtTerminal = isProcessDead(processSchema.parse(start).pid);
        }
      },
    });
    const cancellationTimeout = setTimeout(() => client.cancel(), 15_000);
    try {
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "invocation.activity" &&
              (event.state === "started" || event.state === "progress"),
          ),
        () => ({ events, trace: traceEvents(tracePath) }),
      );
      client.cancel();
      const result = await client.result;
      expect(result.status).toBe(130);
      expect(events.at(-1)?.type).toBe("run.cancelled");
      expect(
        events.filter((event) => event.type === "run.cancelled"),
      ).toHaveLength(1);
      const started = events.filter(
        (event) =>
          event.type === "invocation.activity" &&
          (event.state === "started" || event.state === "progress"),
      );
      expect(started).not.toHaveLength(0);
      for (const activity of started) {
        if (activity.type !== "invocation.activity") continue;
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "invocation.activity",
            activityId: activity.activityId,
            state: "failed",
            input: activity.input,
          }),
        );
      }
      expect(readJsonRpcMethods(tracePath)).toContain("session/cancel");
      const start = traceEvents(tracePath).find(
        ({ event }) => event === "process.started",
      );
      expect(start).toBeDefined();
      expect(start?.persistSession).toBe(false);
      const { pid } = processSchema.parse(start);
      expect(isProcessDead(pid)).toBe(true);
      expect(processDeadAtTerminal).toBe(true);
      expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
    } finally {
      clearTimeout(cancellationTimeout);
      await closeRunnerWorker(client);
    }
  }, 30_000);

  it("maps denied native permission to a typed failure without granting approval", async () => {
    const tracePath = join(temporaryRoot, "cli-permission.jsonl");
    const result = await runCli(
      tracePath,
      "permission",
      "effectAcpSingleWorkflow",
    );
    expect(result.code, JSON.stringify(result)).toBe(1);
    expect(result.result).toMatchObject({
      status: "failed",
      error: {
        category: "ExecutorError",
        message:
          'Task executor failed for "effect-acp-single": Seqlane execution requires human interaction',
      },
    });
    const events = traceEvents(tracePath);
    expect(
      events.filter(({ event }) => event === "session/request_permission"),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "client.response",
        result: { outcome: { outcome: "cancelled" } },
      }),
    );
    expectPeerClosed(tracePath);
    expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
  }, 30_000);

  it("rejects unsupported fork before starting the ACP process", async () => {
    const tracePath = join(temporaryRoot, "ipc-fork.jsonl");
    const client = launchRunner(request("effectAcpForkWorkflow"), {
      runnerPath,
      cwd: consumerRoot,
      environment: fixtureEnvironment(tracePath, "success"),
      signalSource: null,
    });
    const cancellationTimeout = setTimeout(() => client.cancel(), 15_000);
    try {
      const result = await client.result;
      expect(result.status).toBe(1);
      expect(traceEvents(tracePath)).toEqual([]);
    } finally {
      clearTimeout(cancellationTimeout);
      await closeRunnerWorker(client);
    }
  }, 30_000);

  it("fails configured model selection before prompting when the agent omits it", async () => {
    const tracePath = join(temporaryRoot, "cli-missing-model.jsonl");
    const result = await runCli(
      tracePath,
      "missing-model",
      "effectAcpUnsupportedModelWorkflow",
    );
    expect(result.code, JSON.stringify(result)).toBe(1);
    expect(result.result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("not available") },
    });
    const methods = readJsonRpcMethods(tracePath);
    expect(methods).toContain("session/new");
    expect(methods).not.toContain("session/prompt");
    expect(methods).not.toContain("session/set_config_option");
    expectPeerClosed(tracePath);
    expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
  }, 30_000);
});
