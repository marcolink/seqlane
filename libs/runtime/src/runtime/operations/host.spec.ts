import { Effect } from "effect";
import { runTest } from "./native-test-support.js";
// @test-scope ./host.ts
// @test-scope ./run-manager.ts
// @test-scope ./sqlite-store.ts
// @test-scope ./registration.ts
// @test-scope ../execution/effect-plan.ts
// @test-scope ../../runner/profile/runtime-profile.ts
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "@seqlane/core";
import type { AgentAdapter, AgentRuntimeFactory } from "@seqlane/agent-adapter";
import {
  operationalRunEventsSchema,
  operationalRunReferenceSchema,
  operationalRunStatusSchema,
  operationalTraceInspectionSchema,
} from "@seqlane/protocol";
import { z } from "zod";
import { createNativeOperationalHost } from "./host.js";
import { OPERATIONAL_MCP_PATH } from "./mcp.js";
import { createOperationalWorkflow } from "./registration.js";
import { openOperationalStore } from "./sqlite-store.js";
import * as operationalStoreModule from "./sqlite-store.js";

const mcpResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.number().int(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.record(z.string(), z.unknown()).optional(),
});

function readMcpResponse(text: string) {
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  return mcpResponseSchema.parse(JSON.parse(data ?? text));
}

describe("native hosted HTTP transport", () => {
  let host: Awaited<ReturnType<typeof createNativeOperationalHost>> | undefined;
  let directory: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    await host?.close();
    host = undefined;
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    child = undefined;
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("stays closed when listener acquisition races shutdown", async () => {
    host = await createNativeOperationalHost({
      workflows: [
        createOperationalWorkflow({
          key: "race",
          workflow: { input: z.string(), output: z.string() },
          plan: {
            workflow: { id: "race" },
            nodes: [],
            output: { type: "literal", value: "ok" },
          },
          taskDefinitions: new Map(),
        }),
      ],
      storageUrl: "file::memory:",
      port: 0,
    });
    const listening = host.listen();
    const closing = host.close();
    await Promise.allSettled([listening, closing]);
    expect(host.ready).toBe(false);
    expect(
      (await host.fetch(new Request("http://127.0.0.1/healthz"))).status,
    ).toBe(503);
    await expect(host.listen()).rejects.toThrow("Operational host is closed");
  });

  it("runs one workflow over TCP and exposes its result, events, and trace", async () => {
    directory = mkdtempSync(join(tmpdir(), "seqlane-host-http-"));
    const input = z.string();
    const output = z.string();
    const plan: Plan = {
      workflow: { id: "host-http-echo" },
      nodes: [
        {
          type: "task",
          taskId: "host-http-echo.task",
          nodeId: "host-http-echo.task:1",
          workspace: "exclusive",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId: "host-http-echo.task:1", path: [] },
    };
    host = await createNativeOperationalHost({
      workflows: [
        createOperationalWorkflow({
          key: "echo",
          plan,
          workflow: { input, output },
          taskDefinitions: new Map([
            [
              "host-http-echo.task",
              {
                id: "host-http-echo.task",
                input,
                output,
                execute: async () => "",
              },
            ],
          ]),
        }),
      ],
      storageUrl: `file:${join(directory, "operations.db")}`,
      port: 0,
    });
    expect(
      (await host.fetch(new Request("http://127.0.0.1/readyz"))).status,
    ).toBe(503);
    let bodyCancelled = false;
    const stalledRequestInit = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        cancel: () => {
          bodyCancelled = true;
        },
      }),
      duplex: "half" as const,
    };
    const stalled = await host.fetch(
      new Request(
        "http://127.0.0.1/api/workflows/echo/start-async",
        stalledRequestInit,
      ),
    );
    expect(stalled.status).toBe(408);
    expect(bodyCancelled).toBe(true);
    await host.listen();
    const base = host.address;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const ipv6Authority = `[::1]:${host.port}`;
    const ipv6Probe = await host.fetch(
      new Request(`http://${ipv6Authority}/healthz`, {
        headers: { host: ipv6Authority, origin: `http://[::1]:${host.port}` },
      }),
    );
    expect(ipv6Probe.status).toBe(200);
    const malformed = await fetch(`${base}/api/workflows/echo/start-async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const unsafeOrigin = await fetch(`${base}/api/workflows/list`, {
      headers: { origin: "http://localhost:9" },
    });
    expect(unsafeOrigin.status).toBe(400);
    const prototypeKey = await fetch(`${base}/api/runs?version=1&__proto__=x`);
    expect(prototypeKey.status).toBe(400);
    const duplicatePrototypeKey = await fetch(
      `${base}/api/runs?version=1&__proto__=x&__proto__=y`,
    );
    expect(duplicatePrototypeKey.status).toBe(400);
    const validListQuery = await fetch(`${base}/api/runs?version=1&limit=10`);
    expect(validListQuery.status).toBe(200);
    const oversizedStatus = await new Promise<number>(
      (resolveStatus, reject) => {
        const request = httpRequest(
          `${base}/api/workflows/echo/start-async`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
            },
          },
          (response) => {
            response.resume();
            resolveStatus(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.write('{"version":1,"input":"');
        request.write("x".repeat(1024 * 1024));
        request.end('"}');
      },
    );
    expect(oversizedStatus).toBe(413);

    const started = await fetch(`${base}/api/workflows/echo/start-async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, input: "" }),
    });
    expect(started.status).toBe(200);
    const reference = operationalRunReferenceSchema.parse(await started.json());
    expect(reference.status).toBe("queued");
    const runId = reference.runId;

    let status: ReturnType<typeof operationalRunStatusSchema.parse> | undefined;
    await expect
      .poll(async () => {
        const response = await fetch(`${base}/api/runs/${runId}/status`);
        status = operationalRunStatusSchema.parse(await response.json());
        return status.status;
      })
      .toBe("succeeded");
    expect(status?.output).toBe("");
    expect(status?.completeness).toEqual({ inspection: "complete" });
    const scopedStatus = await fetch(
      `${base}/api/workflows/echo/runs/${runId}/status`,
    );
    expect(
      operationalRunStatusSchema.parse(await scopedStatus.json()).status,
    ).toBe("succeeded");

    const eventsResponse = await fetch(
      `${base}/api/runs/${runId}/events?version=1&afterSequence=0&limit=100`,
    );
    expect(
      eventsResponse.status,
      JSON.stringify(await eventsResponse.clone().json()),
    ).toBe(200);
    const events = operationalRunEventsSchema.parse(
      await eventsResponse.json(),
    );
    expect(events.events[0]?.event.type).toBe("run.started");
    expect(events.events.at(-1)?.event.type).toBe("run.succeeded");
    const traceResponse = await fetch(`${base}/api/runs/${runId}/trace`);
    const trace = operationalTraceInspectionSchema.parse(
      await traceResponse.json(),
    );
    expect(trace.completeness).toEqual({ inspection: "complete" });
    expect(
      trace.spans.some(
        (span: { readonly name: string }) => span.name === "seqlane.hosted.run",
      ),
    ).toBe(true);

    const mcpEndpoint = `${base}${OPERATIONAL_MCP_PATH}`;
    const stalledMcpStartedAt = performance.now();
    const stalledMcpOutcome = await new Promise<{
      readonly status?: number;
      readonly error?: string;
    }>((resolveOutcome) => {
      const request = httpRequest(
        mcpEndpoint,
        {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            origin: base,
          },
        },
        (response) => {
          response.resume();
          resolveOutcome({ status: response.statusCode ?? 0 });
        },
      );
      request.on("error", (cause: NodeJS.ErrnoException) =>
        resolveOutcome({ error: cause.code }),
      );
      request.write("{");
    });
    const stalledMcpResult = z
      .strictObject({
        status: z.number().int().optional(),
        error: z.string().optional(),
      })
      .parse(stalledMcpOutcome);
    expect(
      stalledMcpResult.status !== undefined ||
        stalledMcpResult.error !== undefined,
    ).toBe(true);
    expect(performance.now() - stalledMcpStartedAt).toBeGreaterThanOrEqual(
      9_000,
    );
    const initialize = await fetch(mcpEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        origin: base,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "host-http-test", version: "1" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();
    if (sessionId === null)
      throw new Error("MCP initialize response omitted its session ID");
    const tools = await fetch(mcpEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId,
        "mcp-method": "tools/call",
        "mcp-name": "run_echo",
        origin: base,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_echo", arguments: { version: 1, input: "" } },
      }),
    });
    expect(tools.status).toBe(200);
    const mcpResult = readMcpResponse(await tools.text()).result;
    expect(mcpResult).toMatchObject({
      isError: false,
      structuredContent: { status: "succeeded", output: "" },
    });
    const oversizedMcpOutcome = await new Promise<{
      readonly status?: number;
      readonly error?: string;
    }>((resolveOutcome) => {
      const request = httpRequest(
        mcpEndpoint,
        {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            origin: base,
          },
        },
        (response) => {
          response.resume();
          resolveOutcome({ status: response.statusCode ?? 0 });
        },
      );
      request.on("error", (cause: NodeJS.ErrnoException) =>
        resolveOutcome({ error: cause.code }),
      );
      request.write("{");
      request.write(" ".repeat(1024 * 1024));
      request.end("}");
    });
    const rejectedMcpBody = z
      .strictObject({
        status: z.number().int().optional(),
        error: z.literal("ECONNRESET").optional(),
      })
      .parse(oversizedMcpOutcome);
    expect(rejectedMcpBody.error).toBe("ECONNRESET");
  }, 30_000);

  it("marks a killed hosted run interrupted after restart without replaying its task", async () => {
    directory = mkdtempSync(join(tmpdir(), "seqlane-host-crash-"));
    const databasePath = join(directory, "operations.db");
    const storageUrl = `file:${databasePath}`;
    const readyPath = join(directory, "ready.json");
    const counterPath = join(directory, "invocations.txt");
    const workspaceRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../..",
    );
    const fixturePath = fileURLToPath(
      new URL("./host-crash-fixture.ts", import.meta.url),
    );
    const tsxPackage = readdirSync(
      join(workspaceRoot, "node_modules/.pnpm"),
    ).find((name) => name.startsWith("tsx@"));
    if (tsxPackage === undefined)
      throw new Error(
        "The pinned tsx runtime is unavailable for the crash fixture",
      );
    const tsxLoader = join(
      workspaceRoot,
      "node_modules/.pnpm",
      tsxPackage,
      "node_modules/tsx/dist/loader.mjs",
    );
    const fixture = spawn(
      process.execPath,
      ["--import", tsxLoader, fixturePath, storageUrl, readyPath, counterPath],
      {
        cwd: workspaceRoot,
        stdio: "inherit",
      },
    );
    child = fixture;
    let spawnError: Error | undefined;
    fixture.once("error", (cause) => {
      spawnError = cause;
    });
    await expect
      .poll(
        () => {
          if (spawnError !== undefined) throw spawnError;
          if (fixture.exitCode !== null || fixture.signalCode !== null)
            throw new Error(
              `Crash fixture exited before serving (code: ${fixture.exitCode}, signal: ${fixture.signalCode})`,
            );
          return existsSync(readyPath);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const ready = z
      .object({
        address: z.url(),
        port: z.number().int().positive(),
        pid: z.number().int().positive(),
      })
      .parse(JSON.parse(readFileSync(readyPath, "utf8")));
    expect(ready.pid).toBe(child.pid);
    const started = await fetch(
      `${ready.address}/api/workflows/crash-fixture/start-async`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          runId: "crash-run",
          input: "start",
        }),
      },
    );
    expect(started.status).toBe(200);
    await expect
      .poll(() =>
        existsSync(counterPath)
          ? readFileSync(counterPath, "utf8").trim().split("\n").length
          : 0,
      )
      .toBe(1);
    child.kill("SIGKILL");
    await once(child, "exit");
    child = undefined;

    const store = await runTest(openOperationalStore(storageUrl));
    try {
      const status = await runTest(store.status("crash-run"));
      expect(status).toMatchObject({
        status: "interrupted",
        completeness: { inspection: "incomplete" },
      });
      expect(readFileSync(counterPath, "utf8").trim().split("\n")).toEqual([
        "invoked",
      ]);
    } finally {
      await runTest(store.close());
    }
  }, 30_000);

  it("drops readiness and returns 503 when its live storage dependency fails", async () => {
    directory = mkdtempSync(join(tmpdir(), "seqlane-host-storage-failure-"));
    const input = z.string();
    const output = z.string();
    const plan: Plan = {
      workflow: { id: "storage-failure" },
      nodes: [],
      output: { type: "literal", value: "ok" },
    };
    let capturedStore:
      Effect.Success<ReturnType<typeof openOperationalStore>> | undefined;
    const createStore = operationalStoreModule.openOperationalStore;
    const openStore = vi
      .spyOn(operationalStoreModule, "openOperationalStore")
      .mockImplementation((storageUrl) =>
        Effect.gen(function* () {
          capturedStore = yield* createStore(storageUrl);
          return capturedStore;
        }),
      );
    try {
      host = await createNativeOperationalHost({
        workflows: [
          createOperationalWorkflow({
            key: "storage",
            plan,
            workflow: { input, output },
            taskDefinitions: new Map(),
          }),
        ],
        storageUrl: `file:${join(directory, "operations.db")}`,
        port: 0,
      });
      const base = await host.listen();
      if (capturedStore !== undefined) await runTest(capturedStore.close());
      const readiness = await fetch(`${base}/readyz`);
      expect(readiness.status).toBe(503);
      const failed = await fetch(`${base}/api/runs/list?version=1&limit=10`);
      expect(failed.status).toBe(503);
    } finally {
      openStore.mockRestore();
    }
  });

  it("persists fake model, tool, and skill observations across host restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "seqlane-host-observations-"));
    const storageUrl = `file:${join(directory, "operations.db")}`;
    const taskId = "host-observation.task";
    const input = z.unknown();
    const output = z.unknown();
    const nodeId = `${taskId}:1`;
    const plan: Plan = {
      workflow: { id: "host-observation" },
      nodes: [
        {
          type: "task",
          taskId,
          nodeId,
          workspace: "shared",
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId, path: [] },
    };
    const capabilities = {
      execute: true,
      modelSelection: false,
      structuredOutput: false,
      sessionReuse: false,
      checkpoint: false,
      fork: false,
      activity: true,
      sessionUi: false,
    } as const;
    const adapter: AgentAdapter = {
      capabilities,
      execute: async (request) => {
        request.onExecutionStarted();
        request.onObservation?.({
          observationId: "model-observation",
          kind: "model",
          state: "succeeded",
          model: {
            provider: "fixture",
            model: "fixture-model",
            request: {
              enabled: false,
              count: 0,
              text: "",
              values: [false, null, ""],
            },
            response: { accepted: false, result: "", nested: { value: null } },
            usage: { inputTokens: 0, outputTokens: 0 },
            cost: 0,
            startedAt: 100,
            endedAt: 200,
          },
        });
        request.onActivity?.({
          activityId: "tool-observation",
          kind: "tool",
          name: "fixture.tool",
          state: "succeeded",
          input: { enabled: false, count: 0, text: "" },
          output: { success: false, value: "" },
          metadata: { enabled: false, value: null },
          startedAt: 100,
          endedAt: 200,
        });
        request.onActivity?.({
          activityId: "skill-observation",
          kind: "skill",
          name: "fixture-skill",
          state: "succeeded",
          input: "",
          output: false,
          metadata: { loaded: false, path: "" },
          startedAt: 200,
          endedAt: 300,
        });
        return false;
      },
    };
    const agentRuntime: AgentRuntimeFactory = async () => ({
      identity: "host-observation-fixture",
      capabilities,
      createAdapter: () => adapter,
      redactAdapter: (value) => value,
    });
    const workflow = createOperationalWorkflow({
      key: "observations",
      plan,
      workflow: { input, output },
      taskDefinitions: new Map([
        [
          taskId,
          {
            id: taskId,
            input,
            output,
            execute: async ({ context }) =>
              context.runAgent({ goal: "emit fixture observations" }),
          },
        ],
      ]),
      agentRuntime,
    });
    const createHost = () =>
      createNativeOperationalHost({
        workflows: [workflow],
        storageUrl,
        port: 0,
      });
    host = await createHost();
    const base = await host.listen();
    const started = await fetch(
      `${base}/api/workflows/observations/start-async`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          runId: "observation-run",
          input: null,
          runtime: { id: "host-observation-fixture" },
        }),
      },
    );
    expect(started.status).toBe(200);
    let runStatus:
      ReturnType<typeof operationalRunStatusSchema.parse> | undefined;
    await expect
      .poll(async () => {
        const response = await fetch(`${base}/api/runs/observation-run/status`);
        runStatus = operationalRunStatusSchema.parse(await response.json());
        return (
          runStatus.status === "succeeded" || runStatus.status === "failed"
        );
      })
      .toBe(true);
    expect(runStatus, JSON.stringify(runStatus)).toMatchObject({
      status: "succeeded",
    });
    const eventsUrl = `${base}/api/runs/observation-run/events?version=1&afterSequence=0&limit=100`;
    const firstPage = operationalRunEventsSchema.parse(
      await (await fetch(eventsUrl)).json(),
    );
    const modelEvent = firstPage.events.find(
      (item) => item.event.type === "invocation.observation",
    )?.event;
    const toolEvent = firstPage.events.find(
      (item) =>
        item.event.type === "invocation.activity" && item.event.kind === "tool",
    )?.event;
    const skillEvent = firstPage.events.find(
      (item) =>
        item.event.type === "invocation.activity" &&
        item.event.kind === "skill",
    )?.event;
    expect(modelEvent).toMatchObject({
      type: "invocation.observation",
      model: {
        request: {
          enabled: false,
          count: 0,
          text: "",
          values: [false, null, ""],
        },
        response: { accepted: false, result: "" },
        cost: 0,
      },
    });
    expect(toolEvent).toMatchObject({
      input: {
        state: "present",
        value: { enabled: false, count: 0, text: "" },
      },
      output: { state: "present", value: { success: false, value: "" } },
    });
    expect(skillEvent).toMatchObject({
      kind: "skill",
      name: "fixture-skill",
      input: { state: "present", value: "" },
      output: { state: "present", value: false },
    });
    const firstTrace = operationalTraceInspectionSchema.parse(
      await (await fetch(`${base}/api/runs/observation-run/trace`)).json(),
    );
    expect(firstTrace.spans.length).toBeGreaterThan(0);
    if (modelEvent?.type !== "invocation.observation")
      throw new Error("Missing model observation");
    const traceId = modelEvent.metadata.traceparent?.split("-")[1];
    expect(traceId).toBe(firstTrace.spans[0]?.traceId);

    await host.close();
    host = await createHost();
    const reopenedBase = await host.listen();
    const reopenedEvents = operationalRunEventsSchema.parse(
      await (
        await fetch(
          `${reopenedBase}/api/runs/observation-run/events?version=1&afterSequence=0&limit=100`,
        )
      ).json(),
    );
    expect(reopenedEvents.events).toEqual(firstPage.events);
  }, 30_000);
});
