// @test-scope ./operational-host.ts
// @test-scope ./mastra-composition.ts
// @test-scope ./mastra-server.ts
// @test-scope ../compile/mastra-plan-compiler.ts

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkflow,
  createFlow,
  defineTask,
  type Plan,
  type PlanNode,
} from "@seqlane/core";
import type { AgentAdapter } from "@seqlane/agent-adapter";
import { RequestContext } from "@mastra/core/request-context";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRuntimeAdapterRegistry,
  type RuntimeAdapterRegistry,
} from "../../runner/profile/runtime-adapter.js";
import {
  createOperationalHost,
  createOperationalWorkflow,
} from "./operational-host.js";

function workflowPlan(): Plan {
  const node: PlanNode = {
    type: "task",
    taskId: "fixture.task",
    nodeId: "fixture.task:1",
    workspace: "exclusive",
    input: {},
    dependsOn: [],
  };
  return {
    workflow: { id: "fixture-workflow" },
    nodes: [node],
    output: { type: "ref", nodeId: node.nodeId, path: ["output"] },
  };
}

function registration() {
  return createOperationalWorkflow({
    key: "repository:fixture",
    plan: workflowPlan(),
    taskDefinitions: new Map([
      [
        "fixture.task",
        {
          id: "fixture.task",
          input: z.unknown(),
          output: z.unknown(),
          execute: async () => ({}),
        },
      ],
    ]),
  });
}

function localRegistration(adapterConfiguration?: unknown) {
  const node = workflowPlan().nodes[0];
  if (node === undefined || node.type !== "task") {
    throw new Error("Fixture workflow must contain a task node");
  }
  const input = z.object({ required: z.string() });
  const output = z.object({ value: z.string() });
  return createOperationalWorkflow({
    key: "repository:local-fixture",
    plan: {
      ...workflowPlan(),
      nodes: [
        {
          ...node,
          input: { type: "ref", nodeId: "__seqlane_input", path: [] },
        },
      ],
      output: { type: "ref", nodeId: node.nodeId, path: ["output"] },
    },
    taskDefinitions: new Map([
      [
        node.taskId,
        {
          id: node.taskId,
          input,
          output,
          execute: async () => ({ value: "executed-by-owned-host" }),
        },
      ],
    ]),
    workflow: { input, output },
    adapterConfiguration,
  });
}

function runtimeProfileRegistration(
  options: {
    readonly adapterConfiguration?: unknown;
    readonly adapterRegistry?: RuntimeAdapterRegistry;
  } = {},
) {
  const taskId = "investigate-renovate-failure";
  const node: PlanNode = {
    type: "task",
    taskId,
    nodeId: `${taskId}:1`,
    workspace: "shared",
    input: { type: "ref", nodeId: "__seqlane_input", path: [] },
    dependsOn: [],
  };
  const input = z.object({ dependency: z.string().optional() });
  const output = z.object({
    files: z.array(z.string()),
    rootCause: z.string(),
  });
  return createOperationalWorkflow({
    key: "repository:runtime-profile",
    plan: {
      workflow: { id: "runtime-profile" },
      nodes: [node],
      output: { type: "ref", nodeId: node.nodeId, path: [] },
    },
    workflow: { input, output },
    taskDefinitions: new Map([
      [
        taskId,
        {
          id: taskId,
          input,
          output,
          execute: async ({ context }) =>
            context.runAgent({ goal: "complete the fixture task" }),
        },
      ],
    ]),
    adapterConfiguration: options.adapterConfiguration,
    adapterRegistry: options.adapterRegistry,
  });
}

function runtimeProfileAdapterRegistry(
  adapter: AgentAdapter,
): RuntimeAdapterRegistry {
  return createRuntimeAdapterRegistry([
    {
      identity: "acp",
      resolveCapabilities: () => adapter.capabilities,
      prepare: async () => ({}),
      create: () => ({ createAdapter: () => adapter }),
    },
  ]);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function mcpJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine?.slice("data: ".length) ?? body) as Record<
    string,
    unknown
  >;
}

async function openMcpSession(host: {
  listen(): Promise<string>;
}): Promise<{ readonly mcpUrl: string; readonly sessionId: string }> {
  const address = await host.listen();
  const mcpUrl = `${address}/api/mcp/seqlane-workflows/mcp`;
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "seqlane-test", version: "0.0.0" },
      },
    }),
  });
  if (response.status !== 200) {
    throw new Error(
      `MCP initialize failed with status ${response.status}: ${await response.text()}`,
    );
  }
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("MCP session was not created");
  return { mcpUrl, sessionId };
}

function mcpToolCall(
  mcpUrl: string,
  sessionId: string,
  id: number,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "run_repository:runtime-profile",
        arguments: { input: { dependency: "runtime-profile" } },
      },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function parallelRuntimeProfileRegistration(
  options: {
    readonly adapterConfiguration?: unknown;
    readonly adapterRegistry?: RuntimeAdapterRegistry;
  } = {},
) {
  const taskIds = ["parallel.left", "parallel.right"] as const;
  const input = z.object({ dependency: z.string() });
  const output = z.object({ value: z.string() });
  const nodes: readonly PlanNode[] = taskIds.map((taskId) => ({
    type: "task",
    taskId,
    nodeId: `${taskId}:1`,
    workspace: "shared",
    input: { type: "ref", nodeId: "__seqlane_input", path: [] },
    dependsOn: [],
  }));
  return createOperationalWorkflow({
    key: "repository:parallel-runtime-profile",
    plan: {
      workflow: { id: "parallel-runtime-profile" },
      nodes,
      output: { type: "ref", nodeId: "parallel.left:1", path: [] },
    },
    workflow: { input, output },
    taskDefinitions: new Map(
      taskIds.map((taskId) => [
        taskId,
        {
          id: taskId,
          input,
          output,
          execute: async ({ context }) => context.runAgent({ goal: taskId }),
        },
      ]),
    ),
    adapterConfiguration: options.adapterConfiguration,
    adapterRegistry: options.adapterRegistry,
  });
}

describe("Mastra operational host", () => {
  it("registers workflows and becomes ready only after listening", async () => {
    const host = await createOperationalHost({
      workflows: [registration()],
      storageUrl: "file::memory:",
      port: 0,
    });

    await expect(
      json(await host.fetch(new Request("http://host/readyz"))),
    ).resolves.toMatchObject({
      status: "starting",
    });
    expect((await host.fetch(new Request("http://host/readyz"))).status).toBe(
      503,
    );

    const address = await host.listen();
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(host.ready).toBe(true);
    expect((await host.fetch(new Request("http://host/readyz"))).status).toBe(
      200,
    );
    expect((await host.fetch(new Request("http://host/healthz"))).status).toBe(
      200,
    );

    const studioProbe = await host.fetch(
      new Request("http://host/", {
        headers: { origin: "http://localhost:3000" },
      }),
    );
    expect(studioProbe.status).toBe(200);
    expect(studioProbe.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );

    const workflows = await host.fetch(
      new Request("http://host/api/workflows"),
    );
    expect(workflows.status).toBe(200);
    expect(await json(workflows)).toHaveProperty("repository:fixture");

    await host.close();
    await host.close();
    expect(host.ready).toBe(false);
  });

  it("allows Community Studio requests from loopback origins only", async () => {
    const host = await createOperationalHost({
      workflows: [registration()],
      storageUrl: "file::memory:",
      port: 0,
    });

    try {
      const studioResponse = await host.fetch(
        new Request("http://host/api/auth/capabilities", {
          headers: { origin: "http://localhost:3000" },
        }),
      );
      expect(studioResponse.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:3000",
      );
      expect(
        studioResponse.headers.get("access-control-allow-credentials"),
      ).toBe("true");

      const untrustedResponse = await host.fetch(
        new Request("http://host/api/auth/capabilities", {
          headers: { origin: "https://untrusted.example" },
        }),
      );
      expect(
        untrustedResponse.headers.get("access-control-allow-origin"),
      ).toBeNull();
    } finally {
      await host.close();
    }
  });

  it("exposes the registered Seqlane MCP server through Mastra HTTP routes", async () => {
    let receivedRuntimeId: string | undefined;
    let closed = 0;
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    };
    const adapter: AgentAdapter = {
      capabilities,
      execute: async () => ({
        files: ["package.json"],
        rootCause: `runtime=${receivedRuntimeId}`,
      }),
      close: async () => {
        closed += 1;
      },
    };
    const adapterRegistry = createRuntimeAdapterRegistry([
      {
        identity: "acp",
        resolveCapabilities: () => capabilities,
        prepare: async () => ({}),
        create: (_configuration, context) => {
          receivedRuntimeId = context.requestContext?.get(
            "seqlane.runtimeId",
          ) as string | undefined;
          return { createAdapter: () => adapter };
        },
      },
    ]);
    const host = await createOperationalHost({
      workflows: [
        runtimeProfileRegistration({
          adapterConfiguration: {
            adapter: "acp",
            configuration: {
              id: "fixture-agent",
              description: "Fixture agent",
              command: "fixture-agent",
              persistSession: true,
            },
          },
          adapterRegistry,
        }),
      ],
      storageUrl: "file::memory:",
      port: 0,
    });

    try {
      const address = await host.listen();

      const servers = await fetch(`${address}/api/mcp/v0/servers`);
      expect(servers.status).toBe(200);
      expect(await json(servers)).toMatchObject({
        servers: [expect.objectContaining({ id: "seqlane-workflows" })],
      });

      const tools = await fetch(`${address}/api/mcp/seqlane-workflows/tools`);
      expect(tools.status).toBe(200);
      expect(await json(tools)).toMatchObject({
        tools: [
          expect.objectContaining({ name: "run_repository:runtime-profile" }),
        ],
      });

      const mcpUrl = `${address}/api/mcp/seqlane-workflows/mcp`;
      const initialize = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "seqlane-test", version: "0.0.0" },
          },
        }),
      });
      if (initialize.status !== 200) {
        throw new Error(await initialize.clone().text());
      }
      expect(await mcpJson(initialize)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          serverInfo: { name: "Seqlane Workflows" },
        },
      });
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).toEqual(expect.any(String));

      const listedTools = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        }),
      });
      expect(listedTools.status).toBe(200);
      expect(await mcpJson(listedTools)).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            expect.objectContaining({ name: "run_repository:runtime-profile" }),
          ],
        },
      });

      const defaultRuntimeCall = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "run_repository:runtime-profile",
            arguments: { input: { dependency: "runtime-profile" } },
          },
        }),
      });
      expect(defaultRuntimeCall.status).toBe(200);
      expect(await mcpJson(defaultRuntimeCall)).toMatchObject({
        result: {
          content: [
            {
              type: "text",
              text: expect.stringContaining('"rootCause":"runtime=opencode"'),
            },
          ],
        },
      });

      const calledTool = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "run_repository:runtime-profile",
            arguments: {
              input: { dependency: "runtime-profile" },
              runtime: { id: "test-fixture" },
            },
          },
        }),
      });
      expect(calledTool.status).toBe(200);
      expect(await mcpJson(calledTool)).toMatchObject({
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                '"rootCause":"Renovate updated a dependency without its peer range"',
              ),
            },
          ],
        },
      });

      const arbitraryAdapterConfig = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "run_repository:runtime-profile",
            arguments: {
              input: { dependency: "runtime-profile" },
              runtime: {
                id: "opencode",
                adapter: "opencode",
                url: "http://attacker.invalid",
              },
            },
          },
        }),
      });
      expect(arbitraryAdapterConfig.status).toBe(200);
      expect(await mcpJson(arbitraryAdapterConfig)).toMatchObject({
        result: {
          isError: true,
        },
      });
    } finally {
      await host.close();
    }
    expect(closed).toBe(1);
  });

  it("closes an operational adapter after invocation failure", async () => {
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    };
    let closed = 0;
    const adapter: AgentAdapter = {
      capabilities,
      execute: async () => {
        throw new Error("fixture adapter failed");
      },
      close: async () => {
        closed += 1;
      },
    };
    const host = await createOperationalHost({
      workflows: [
        runtimeProfileRegistration({
          adapterConfiguration: {
            adapter: "acp",
            configuration: {
              id: "fixture-agent",
              description: "Fixture agent",
              command: "fixture-agent",
              persistSession: true,
            },
          },
          adapterRegistry: runtimeProfileAdapterRegistry(adapter),
        }),
      ],
      storageUrl: "file::memory:",
      port: 0,
    });

    try {
      const { mcpUrl, sessionId } = await openMcpSession(host);
      const response = await mcpToolCall(mcpUrl, sessionId, 2);
      const payload = await mcpJson(response);
      expect(payload).toMatchObject({
        result: {
          content: [{ text: expect.stringContaining('"status":"failed"') }],
        },
      });
      expect(closed).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("does not retry a failed operational cleanup", async () => {
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    };
    let closeAttempts = 0;
    const adapter: AgentAdapter = {
      capabilities,
      execute: async () => {
        throw new Error("fixture adapter failed");
      },
      close: async () => {
        closeAttempts += 1;
        throw new Error("fixture cleanup failed");
      },
    };
    const registration = runtimeProfileRegistration({
      adapterConfiguration: {
        adapter: "acp",
        configuration: {
          id: "fixture-agent",
          description: "Fixture agent",
          command: "fixture-agent",
          persistSession: true,
        },
      },
      adapterRegistry: runtimeProfileAdapterRegistry(adapter),
    });
    const workflow = registration.workflow as AnyWorkflow;
    const runId = "run-failed-cleanup";
    const run = await workflow.createRun({
      runId,
      resourceId: "work-run-failed-cleanup",
      shouldPersistSnapshot: () => false,
    });

    const outcome = await run.start({
      inputData: { dependency: "runtime-profile" },
      requestContext: new RequestContext([
        ["seqlane.runtimeId", "test-runtime"],
      ]),
    });
    expect(outcome.status).toBe("failed");
    await registration.terminate?.(runId);
    await registration.terminate?.(runId);
    expect(closeAttempts).toBe(1);
  });

  it("closes an operational adapter when an invocation is cancelled", async () => {
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    };
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let closed = 0;
    const adapter: AgentAdapter = {
      capabilities,
      execute: async ({ signal }) => {
        started();
        await new Promise<never>((resolve, reject) => {
          const onAbort = () => reject(new Error("fixture adapter aborted"));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
      close: async () => {
        closed += 1;
      },
    };
    const registration = runtimeProfileRegistration({
      adapterConfiguration: {
        adapter: "acp",
        configuration: {
          id: "fixture-agent",
          description: "Fixture agent",
          command: "fixture-agent",
          persistSession: true,
        },
      },
      adapterRegistry: runtimeProfileAdapterRegistry(adapter),
    });
    const workflow = registration.workflow as AnyWorkflow;
    const run = await workflow.createRun({
      runId: "run-cancel",
      resourceId: "work-run-cancel",
      shouldPersistSnapshot: () => false,
    });

    const outcome = run.start({
      inputData: { dependency: "runtime-profile" },
      requestContext: new RequestContext([
        ["seqlane.runtimeId", "test-runtime"],
      ]),
    });
    await executionStarted;
    await run.cancel();
    await outcome;
    await registration.terminate?.("run-cancel");
    expect(closed).toBe(1);
  });

  it("waits for parallel nodes before terminal adapter cleanup", async () => {
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    };
    let rightStarted!: () => void;
    const rightExecutionStarted = new Promise<void>((resolve) => {
      rightStarted = resolve;
    });
    let releaseRight!: () => void;
    const rightExecutionReleased = new Promise<void>((resolve) => {
      releaseRight = resolve;
    });
    let closed = 0;
    const adapter: AgentAdapter = {
      capabilities,
      execute: async ({ task }) => {
        if (task.id === "parallel.right") {
          rightStarted();
          await rightExecutionReleased;
        }
        return { value: task.id };
      },
      close: async () => {
        closed += 1;
      },
    };
    const registration = parallelRuntimeProfileRegistration({
      adapterConfiguration: {
        adapter: "acp",
        configuration: {
          id: "fixture-agent",
          description: "Fixture agent",
          command: "fixture-agent",
          persistSession: true,
        },
      },
      adapterRegistry: runtimeProfileAdapterRegistry(adapter),
    });
    const workflow = registration.workflow as AnyWorkflow;
    const run = await workflow.createRun({
      runId: "run-parallel-cleanup",
      resourceId: "work-run-parallel-cleanup",
      shouldPersistSnapshot: () => false,
    });

    const outcome = run.start({
      inputData: { dependency: "runtime-profile" },
      requestContext: new RequestContext([
        ["seqlane.runtimeId", "test-runtime"],
      ]),
    });
    await rightExecutionStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(0);

    releaseRight();
    await outcome;
    await registration.terminate?.("run-parallel-cleanup");
    expect(closed).toBe(1);
  });

  it("keeps a shared adapter open when one parallel node fails", async () => {
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    };
    let rightStarted!: () => void;
    const rightExecutionStarted = new Promise<void>((resolve) => {
      rightStarted = resolve;
    });
    let releaseRight!: () => void;
    const rightExecutionReleased = new Promise<void>((resolve) => {
      releaseRight = resolve;
    });
    let leftFailed!: () => void;
    const leftFailureObserved = new Promise<void>((resolve) => {
      leftFailed = resolve;
    });
    let closed = 0;
    const adapter: AgentAdapter = {
      capabilities,
      execute: async ({ task }) => {
        if (task.id === "parallel.left") {
          await rightExecutionStarted;
          leftFailed();
          throw new Error("fixture left node failed");
        }
        rightStarted();
        await rightExecutionReleased;
        return { value: task.id };
      },
      close: async () => {
        closed += 1;
      },
    };
    const registration = parallelRuntimeProfileRegistration({
      adapterConfiguration: {
        adapter: "acp",
        configuration: {
          id: "fixture-agent",
          description: "Fixture agent",
          command: "fixture-agent",
          persistSession: true,
        },
      },
      adapterRegistry: runtimeProfileAdapterRegistry(adapter),
    });
    const workflow = registration.workflow as AnyWorkflow;
    const runId = "run-parallel-failure";
    const run = await workflow.createRun({
      runId,
      resourceId: "work-run-parallel-failure",
      shouldPersistSnapshot: () => false,
    });
    const outcome = run.start({
      inputData: { dependency: "runtime-profile" },
      requestContext: new RequestContext([
        ["seqlane.runtimeId", "test-runtime"],
      ]),
    });
    void outcome.catch(() => undefined);
    await leftFailureObserved;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(0);

    let cleanupSettled = false;
    if (registration.terminate === undefined) {
      throw new Error("Operational registration must expose terminal cleanup");
    }
    const cleanup = registration.terminate(runId).then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(closed).toBe(0);

    releaseRight();
    expect((await outcome).status).toBe("failed");
    await cleanup;
    await registration.terminate(runId);
    expect(closed).toBe(1);
  });

  it("rejects non-loopback startup before opening storage or a listener", async () => {
    await expect(
      createOperationalHost({
        workflows: [registration()],
        host: "0.0.0.0",
        storageUrl: "file:/path/that/must/not/be opened",
      }),
    ).rejects.toThrow("loopback");
  });

  it("normalizes bracketed IPv6 input for binding and advertised URLs", async () => {
    const host = await createOperationalHost({
      workflows: [registration()],
      host: "[::1]",
      storageUrl: "file::memory:",
      port: 0,
    });

    expect(host.host).toBe("::1");
    await expect(host.listen()).resolves.toMatch(/^http:\/\/\[::1\]:\d+$/);
    await host.close();
  });

  it("reopens the same durable storage file after host shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-operational-host-"));
    const storagePath = join(directory, "mastra.db");
    try {
      const first = await createOperationalHost({
        workflows: [registration()],
        storageUrl: `file:${storagePath}`,
        port: 0,
      });
      await first.listen();
      await first.close();
      expect(existsSync(storagePath)).toBe(true);

      const second = await createOperationalHost({
        workflows: [registration()],
        storageUrl: `file:${storagePath}`,
        port: 0,
      });
      await second.listen();
      expect(
        (await second.fetch(new Request("http://host/readyz"))).status,
      ).toBe(200);
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("executes a local Seqlane task through the owned Mastra host", async () => {
    const host = await createOperationalHost({
      workflows: [localRegistration()],
      storageUrl: "file::memory:",
      port: 0,
    });
    try {
      await host.listen();
      const response = await host.fetch(
        new Request(
          "http://host/api/workflows/repository%3Alocal-fixture/start-async?runId=run-local",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              resourceId: "work-local",
              inputData: { required: "value" },
              requestContext: { "seqlane.runtimeId": "local" },
            }),
          },
        ),
      );

      expect(response.status).toBe(200);
      const localResult = await json(response);
      expect(localResult, JSON.stringify(localResult)).toMatchObject({
        status: "success",
        result: { value: "executed-by-owned-host" },
      });

      const invalidInputResponse = await host.fetch(
        new Request(
          "http://host/api/workflows/repository%3Alocal-fixture/start-async?runId=run-invalid-input",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              resourceId: "work-invalid-input",
              inputData: {},
              requestContext: { "seqlane.runtimeId": "local" },
            }),
          },
        ),
      );
      await expect(json(invalidInputResponse)).resolves.toMatchObject({
        error: expect.stringContaining("Invalid input"),
      });
    } finally {
      await host.close();
    }
  });

  it("executes nested workflows through the owned Mastra host", async () => {
    const childTask = defineTask({
      id: "operational-child-task",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ input }) => ({ result: input.value + 1 }),
    });
    const child = createFlow({
      id: "operational-child",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
    })
      .task("increment", childTask, ({ input }) => input)
      .output(({ tasks }) => tasks.increment.output)
      .define();
    const parent = createFlow({
      id: "operational-parent",
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
    })
      .task("child", child, ({ input }) => input)
      .output(({ tasks }) => tasks.child.output)
      .define();
    const built = buildWorkflow(parent);
    const host = await createOperationalHost({
      workflows: [
        createOperationalWorkflow({
          key: "repository:operational-parent",
          plan: built.plan,
          workflow: built.workflow,
          taskDefinitions: built.taskDefinitions,
          validatorDefinitions: built.validatorDefinitions,
          workflowDefinitions: built.workflowDefinitions,
        }),
      ],
      storageUrl: "file::memory:",
      port: 0,
    });

    try {
      const response = await host.fetch(
        new Request(
          "http://host/api/workflows/repository%3Aoperational-parent/start-async?runId=run-operational-nested",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              resourceId: "work-operational-nested",
              inputData: { value: 2 },
              requestContext: { "seqlane.runtimeId": "local" },
            }),
          },
        ),
      );

      expect(response.status).toBe(200);
      await expect(json(response)).resolves.toMatchObject({
        status: "success",
        result: { result: 3 },
      });
    } finally {
      await host.close();
    }
  });

  it("uses the adapter configuration supplied by the operational composition root", async () => {
    const previousConfiguration = process.env.SEQLANE_RUNTIME_ADAPTER_CONFIG;
    delete process.env.SEQLANE_RUNTIME_ADAPTER_CONFIG;
    const configuredRuntimeUrl = "http://configured-runtime.invalid";
    const fetchMock = async (): Promise<Response> =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    const host = await createOperationalHost({
      workflows: [
        localRegistration({
          adapter: "opencode",
          url: configuredRuntimeUrl,
        }),
      ],
      storageUrl: "file::memory:",
      port: 0,
    });

    try {
      await host.listen();
      const response = await host.fetch(
        new Request(
          "http://host/api/workflows/repository%3Alocal-fixture/start-async?runId=run-configured-adapter",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              resourceId: "work-configured-adapter",
              inputData: { required: "value" },
              requestContext: { "seqlane.runtimeId": "opaque-profile" },
            }),
          },
        ),
      );

      expect(response.status).toBe(200);
      await expect(json(response)).resolves.toMatchObject({
        status: "success",
        result: { value: "executed-by-owned-host" },
      });
    } finally {
      await host.close();
      globalThis.fetch = previousFetch;
      if (previousConfiguration === undefined) {
        delete process.env.SEQLANE_RUNTIME_ADAPTER_CONFIG;
      } else {
        process.env.SEQLANE_RUNTIME_ADAPTER_CONFIG = previousConfiguration;
      }
    }
  });

  it("rejects an empty workflow registry", async () => {
    await expect(
      createOperationalHost({ workflows: [], storageUrl: "file::memory:" }),
    ).rejects.toThrow("At least one workflow");
  });
});
