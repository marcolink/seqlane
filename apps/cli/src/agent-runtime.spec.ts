// @test-scope ./agent-runtime.ts
// @test-scope ../../../libs/runtime/src/runtime/operations/host.ts
import type { AgentAdapter, AgentRuntimeFactory } from "@seqlane/agent-adapter";
import type { Plan, PlanNode, SeqlaneEvent } from "@seqlane/core";
import {
  operationalRunReferenceSchema,
  operationalRunStatusSchema,
  type SeqlaneObservation,
} from "@seqlane/protocol";
import { startOpenCodeService } from "@seqlane/opencode-adapter";
import { createOpenCodeAdapterForRun } from "@seqlane/opencode-adapter/testing";
import {
  createOperationalHost,
  createOperationalWorkflow,
} from "@seqlane/runtime/operational-host";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentRuntimeConfigurationError,
  createAgentRuntimeFactory,
  createDirectRunAdapterConfiguration,
  directRunAdapterConfigurationEnvironment,
  loadDirectRunAgentRuntimeFactory,
} from "./agent-runtime.js";

vi.mock("@seqlane/opencode-adapter", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@seqlane/opencode-adapter")>();
  return { ...original, startOpenCodeService: vi.fn() };
});

const input = z.object({ value: z.string() });
const output = z.object({ value: z.string() });

function injectedRuntime(adapter: AgentAdapter): AgentRuntimeFactory {
  return async () => ({
    identity: "observability-fixture",
    capabilities: adapter.capabilities,
    createAdapter: () => adapter,
    redactAdapter: (value) => value,
  });
}

function agentWorkflow(
  key: string,
  agentRuntime: AgentRuntimeFactory,
  events: SeqlaneEvent[],
) {
  const taskId = `${key}.task`;
  const node: PlanNode = {
    type: "task",
    taskId,
    nodeId: `${taskId}:1`,
    workspace: "shared",
    input: { type: "ref", nodeId: "__seqlane_input", path: [] },
    dependsOn: [],
  };
  const plan: Plan = {
    workflow: { id: key },
    nodes: [node],
    output: { type: "ref", nodeId: node.nodeId, path: [] },
  };
  return createOperationalWorkflow({
    key,
    plan,
    workflow: { input, output },
    eventSink: () => ({
      emit: (event) => events.push(event),
      emitPlan: () => undefined,
    }),
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
    agentRuntime,
  });
}

async function operationalHostEvents(
  key: string,
  adapter: AgentAdapter,
  traceId: string,
): Promise<SeqlaneEvent[]> {
  const events: SeqlaneEvent[] = [];
  const host = await createOperationalHost({
    workflows: [agentWorkflow(key, injectedRuntime(adapter), events)],
    storageUrl: "file::memory:",
    port: 0,
  });
  try {
    await host.listen();
    const response = await host.fetch(
      new Request(
        `${host.address}/api/workflows/${encodeURIComponent(key)}/start-async`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            workId: `work-${traceId}`,
            runId: traceId,
            input: { value: "demo" },
            runtime: { id: "direct" },
          }),
        },
      ),
    );
    expect(response.status).toBe(200);
    const reference = operationalRunReferenceSchema.parse(
      await response.json(),
    );
    await expect
      .poll(async () => {
        const statusResponse = await host.fetch(
          new Request(`${host.address}/api/runs/${reference.runId}/status`),
        );
        return operationalRunStatusSchema.parse(await statusResponse.json());
      })
      .toMatchObject({ status: "succeeded", output: { value: "done" } });
    return events;
  } finally {
    await host.close();
  }
}

describe("CLI agent runtime composition", () => {
  it("accepts only supported direct-run adapter configuration", async () => {
    const encoded = createDirectRunAdapterConfiguration({
      adapter: "opencode",
      mode: "managed",
      host: "127.0.0.1",
      port: 4123,
    });
    expect(JSON.parse(encoded)).toEqual({
      adapter: "opencode",
      mode: "managed",
      host: "127.0.0.1",
      port: 4123,
    });
    expect(
      JSON.parse(
        createDirectRunAdapterConfiguration({
          adapter: "opencode",
          mode: "managed",
          host: "0:0:0:0:0:0:0:1",
        }),
      ),
    ).toMatchObject({ host: "::1" });
    expect(() =>
      createDirectRunAdapterConfiguration({ adapter: "opencode" }),
    ).toThrow();
    expect(
      JSON.parse(
        createDirectRunAdapterConfiguration({
          adapter: "opencode",
          mode: "external",
          host: "0:0:0:0:0:0:0:1",
          port: 4123,
        }),
      ),
    ).toEqual({
      adapter: "opencode",
      mode: "external",
      host: "::1",
      port: 4123,
    });
    expect(() =>
      createDirectRunAdapterConfiguration({
        adapter: "opencode",
        mode: "managed",
        host: "192.168.1.1",
      }),
    ).toThrow();
    expect(() =>
      loadDirectRunAgentRuntimeFactory({
        [directRunAdapterConfigurationEnvironment]: JSON.stringify({
          adapter: "opencode",
          host: "127.0.0.1",
          port: 4123,
        }),
      }),
    ).toThrow("Agent runtime configuration: configuration is invalid");
    expect(() =>
      createDirectRunAdapterConfiguration({
        adapter: "opencode",
        mode: "external",
        host: "127.0.0.1",
        port: 0,
      }),
    ).toThrow();
    expect(() =>
      createDirectRunAdapterConfiguration({
        adapter: "opencode",
        mode: "external",
        host: "127.0.0.1",
      }),
    ).toThrow();

    const factory = loadDirectRunAgentRuntimeFactory({
      [directRunAdapterConfigurationEnvironment]: JSON.stringify({
        adapter: "codex",
      }),
    });
    expect(factory).toEqual(expect.any(Function));
    expect(() =>
      createDirectRunAdapterConfiguration({
        adapter: "codex",
        host: "127.0.0.1",
      }),
    ).toThrow();
  });

  it("uses an external OpenCode server without owning its lifecycle", async () => {
    vi.clearAllMocks();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>OpenCode</body></html>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listening address");
    }

    try {
      const factory = loadDirectRunAgentRuntimeFactory({
        [directRunAdapterConfigurationEnvironment]:
          createDirectRunAdapterConfiguration({
            adapter: "opencode",
            mode: "external",
            host: "127.0.0.1",
            port: address.port,
          }),
      });
      const onOwnedProcessAcquired = vi.fn(async (_pid: number) => undefined);
      const runtime = await factory(
        new AbortController().signal,
        process.cwd(),
        { onOwnedProcessAcquired },
      );
      await runtime.close?.();

      expect(startOpenCodeService).not.toHaveBeenCalled();
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      expect(response.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  it("uses a bracketed IPv6 endpoint for an external OpenCode server", async () => {
    vi.clearAllMocks();
    let requestHost: string | undefined;
    const server = createServer((request, response) => {
      requestHost = request.headers.host;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>OpenCode</body></html>");
    });
    server.listen(0, "::1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an IPv6 TCP listening address");
    }

    try {
      const factory = loadDirectRunAgentRuntimeFactory({
        [directRunAdapterConfigurationEnvironment]:
          createDirectRunAdapterConfiguration({
            adapter: "opencode",
            mode: "external",
            host: "0:0:0:0:0:0:0:1",
            port: address.port,
          }),
      });
      await factory(new AbortController().signal, process.cwd());

      expect(requestHost).toBe(`[::1]:${address.port}`);
      expect(startOpenCodeService).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  it("leaves an external OpenCode server alive after a runtime error", async () => {
    vi.clearAllMocks();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>OpenCode</body></html>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listening address");
    }

    try {
      const factory = loadDirectRunAgentRuntimeFactory({
        [directRunAdapterConfigurationEnvironment]:
          createDirectRunAdapterConfiguration({
            adapter: "opencode",
            mode: "external",
            host: "127.0.0.1",
            port: address.port,
          }),
      });
      const runtime = await factory(
        new AbortController().signal,
        process.cwd(),
      );
      if (runtime.modelCapabilities === undefined) {
        throw new Error("Expected OpenCode model capabilities");
      }
      await expect(runtime.modelCapabilities.listModels()).rejects.toThrow();

      expect(startOpenCodeService).not.toHaveBeenCalled();
      expect((await fetch(`http://127.0.0.1:${address.port}`)).ok).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  it("leaves an external OpenCode server alive after cancellation", async () => {
    vi.clearAllMocks();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>OpenCode</body></html>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listening address");
    }

    try {
      const factory = loadDirectRunAgentRuntimeFactory({
        [directRunAdapterConfigurationEnvironment]:
          createDirectRunAdapterConfiguration({
            adapter: "opencode",
            mode: "external",
            host: "127.0.0.1",
            port: address.port,
          }),
      });
      const controller = new AbortController();
      const runtime = await factory(controller.signal, process.cwd());
      controller.abort();
      await runtime.close?.();

      expect(startOpenCodeService).not.toHaveBeenCalled();
      expect((await fetch(`http://127.0.0.1:${address.port}`)).ok).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  it("keeps managed OpenCode service ownership", async () => {
    vi.clearAllMocks();
    const authorizations: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      if (request.url?.startsWith("/provider")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ all: [], default: {}, connected: [] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>OpenCode</body></html>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listening address");
    }
    const close = vi.fn(async () => undefined);
    vi.mocked(startOpenCodeService).mockResolvedValue({
      url: `http://127.0.0.1:${address.port}`,
      authorization: "Basic test-owned-credential",
      diagnostics: () => "",
      close,
    });

    try {
      const factory = loadDirectRunAgentRuntimeFactory({
        [directRunAdapterConfigurationEnvironment]:
          createDirectRunAdapterConfiguration({
            adapter: "opencode",
            mode: "managed",
          }),
      });
      const onOwnedProcessAcquired = vi.fn(async (_pid: number) => undefined);
      const runtime = await factory(
        new AbortController().signal,
        process.cwd(),
        { onOwnedProcessAcquired },
      );
      await runtime.modelCapabilities?.listModels();
      await runtime.close?.();
      expect(authorizations.length).toBeGreaterThanOrEqual(2);
      expect(
        authorizations.every(
          (value) => value === "Basic test-owned-credential",
        ),
      ).toBe(true);

      expect(startOpenCodeService).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "127.0.0.1",
          port: 0,
          onOwnedProcessAcquired,
        }),
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  it("does not interpret configuration for an unknown adapter", () => {
    const unsupportedIdentity = "private-adapter-name";
    try {
      createAgentRuntimeFactory({ adapter: unsupportedIdentity });
      throw new Error("Expected unknown adapter configuration to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(AgentRuntimeConfigurationError);
      expect(cause).toHaveProperty(
        "message",
        "Agent runtime configuration: adapter is unavailable",
      );
      expect(String(cause)).not.toContain(unsupportedIdentity);
    }
  });

  it("retains OpenCode model records and forwards activities in hosted execution", async () => {
    const canonicalObservations: {
      invocationId: string;
      observation: SeqlaneObservation;
    }[] = [];
    const nativeAdapter = createOpenCodeAdapterForRun({
      prompt: async (prompt) => {
        prompt.onNativeRequest?.({
          model: { providerID: "fixture-provider", modelID: "fixture-model" },
          messages: [{ role: "user", content: "complete request" }],
        });
        prompt.onNativeResponse?.({
          id: "native-response-1",
          content: [{ type: "text", text: "complete response" }],
        });
        prompt.onActivity?.({
          activityId: "skill-activity-1",
          kind: "skill",
          name: "repository-guide",
          state: "succeeded",
          input: { path: "AGENTS.md" },
          output: "Loaded repository guidance",
          metadata: { source: "fixture" },
          startedAt: 10,
          endedAt: 12,
        });
        prompt.onActivity?.({
          activityId: "opencode-call",
          kind: "tool",
          name: "echo",
          state: "succeeded",
          input: { secret: "opencode-input" },
          output: "opencode-output",
          metadata: { transcript: "opencode-transcript" },
          startedAt: 10,
          endedAt: 12,
        });
        return {
          structured: { value: "done" },
          text: "complete assistant response",
          nativeResponse: {
            id: "native-response-1",
            content: [{ type: "text", text: "complete response" }],
          },
          metrics: {
            provider: "fixture-provider",
            model: "fixture-model",
            cost: 0.25,
            tokens: {
              total: 7,
              input: 4,
              output: 3,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
          observation: {
            kind: "assistant",
            sessionID: "opencode-session",
            messageID: "opencode-message",
            created: 20,
            completed: 30,
            provider: "fixture-provider",
            model: "fixture-model",
            tokens: {
              input: 4,
              output: 3,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            cost: 0.25,
            finish: "stop",
          },
        };
      },
      checkpoint: async () => ({
        sessionId: "opencode-session",
        messageId: "opencode-message",
      }),
      fork: async () => {
        throw new Error("fork is not used by hosted verification");
      },
      abort: async () => undefined,
      close: async () => undefined,
    });
    const adapter: AgentAdapter = {
      ...nativeAdapter,
      execute: (request) =>
        nativeAdapter.execute({
          ...request,
          onObservation: (observation) => {
            canonicalObservations.push({
              invocationId: request.invocationId,
              observation,
            });
            request.onObservation?.(observation);
          },
        }),
    };
    const events = await operationalHostEvents(
      "repository:opencode-observability",
      adapter,
      "11111111111111111111111111111111",
    );
    expect(canonicalObservations).toHaveLength(2);
    expect(canonicalObservations[0]).toMatchObject({
      invocationId: expect.any(String),
      observation: {
        kind: "model",
        state: "started",
        observationId: expect.any(String),
      },
    });
    expect(canonicalObservations[1]).toMatchObject({
      invocationId: canonicalObservations[0]?.invocationId,
      observation: {
        kind: "model",
        state: "succeeded",
        observationId: canonicalObservations[0]?.observation.observationId,
      },
    });
    expect(canonicalObservations[1]?.observation).toMatchObject({
      model: {
        operation: "chat",
        provider: "fixture-provider",
        model: "fixture-model",
        responseId: "opencode-message",
        finishReasons: ["stop"],
        request: expect.objectContaining({
          native: {
            model: { providerID: "fixture-provider", modelID: "fixture-model" },
            messages: [{ role: "user", content: "complete request" }],
          },
        }),
        response: {
          structured: { value: "done" },
          text: "complete assistant response",
          native: {
            id: "native-response-1",
            content: [{ type: "text", text: "complete response" }],
          },
        },
        usage: {
          inputTokens: 4,
          outputTokens: 3,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        cost: 0.25,
        startedAt: 20,
        endedAt: 30,
      },
    });
    const activities = events.filter(
      (event) => event.type === "invocation.activity",
    );
    expect(activities).toHaveLength(2);
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workId: "work-11111111111111111111111111111111",
          runId: "11111111111111111111111111111111",
          invocationId: canonicalObservations[0]?.invocationId,
          activityId: "opencode-call",
          kind: "tool",
          name: "echo",
          state: "succeeded",
          input: { state: "present", value: { secret: "opencode-input" } },
          output: { state: "present", value: "opencode-output" },
          activityMetadata: {
            state: "present",
            value: { transcript: "opencode-transcript" },
          },
          startedAt: 10,
          endedAt: 12,
        }),
        expect.objectContaining({
          workId: "work-11111111111111111111111111111111",
          runId: "11111111111111111111111111111111",
          invocationId: canonicalObservations[0]?.invocationId,
          activityId: "skill-activity-1",
          kind: "skill",
          name: "repository-guide",
          state: "succeeded",
          input: { state: "present", value: { path: "AGENTS.md" } },
          output: {
            state: "present",
            value: "Loaded repository guidance",
          },
          activityMetadata: { state: "present", value: { source: "fixture" } },
          startedAt: 10,
          endedAt: 12,
        }),
      ]),
    );
  });
});
