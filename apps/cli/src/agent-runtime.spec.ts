// @test-scope ./agent-runtime.ts
// @test-scope ../../../libs/runtime/src/runtime/mastra/operational-host.ts
import type { AgentAdapter, AgentRuntimeFactory } from "@seqlane/agent-adapter";
import {
  createAcpAdapter,
  parseAcpLaunchConfiguration,
} from "@seqlane/acp-adapter";
import type { Plan, PlanNode } from "@seqlane/core";
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

function agentWorkflow(key: string, agentRuntime: AgentRuntimeFactory) {
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

async function persistedTrace(
  key: string,
  adapter: AgentAdapter,
  traceId: string,
): Promise<unknown> {
  const host = await createOperationalHost({
    workflows: [agentWorkflow(key, injectedRuntime(adapter))],
    storageUrl: "file::memory:",
    port: 0,
  });
  try {
    const response = await host.fetch(
      new Request(
        `http://host/api/workflows/${encodeURIComponent(key)}/start-async?runId=${traceId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resourceId: `work-${traceId}`,
            inputData: { value: "demo" },
            requestContext: { "seqlane.runtimeId": "direct" },
            tracingOptions: { traceId },
          }),
        },
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "success",
      result: { value: "done" },
    });
    return await host.inspectTrace(traceId);
  } finally {
    await host.close();
  }
}

function expectPersistedAdapterTrace(
  trace: unknown,
  adapter: "acp-v1" | "opencode",
  tool: string,
  callId: string,
): void {
  expect(trace).toMatchObject({
    spans: expect.arrayContaining([
      expect.objectContaining({
        type: "agent_run",
        metadata: expect.objectContaining({
          "seqlane.adapter": adapter,
        }),
      }),
      expect.objectContaining({
        type: "tool_call",
        name: tool,
        attributes: expect.objectContaining({
          toolType: "tool",
          toolCallId: callId,
          success: true,
        }),
      }),
    ]),
  });
  if (
    typeof trace !== "object" ||
    trace === null ||
    !("spans" in trace) ||
    !Array.isArray(trace.spans)
  ) {
    throw new TypeError("Expected a persisted trace with spans");
  }
  const agentSpan = trace.spans.find(
    (span) =>
      typeof span === "object" && span !== null && span.type === "agent_run",
  );
  const toolSpan = trace.spans.find(
    (span) =>
      typeof span === "object" && span !== null && span.type === "tool_call",
  );
  expect(toolSpan?.parent).toBe(agentSpan);
  expect(agentSpan?.parent).toMatchObject({ type: "workflow_step" });
}

function serializedSpanFields(trace: unknown): string {
  if (
    typeof trace !== "object" ||
    trace === null ||
    !("spans" in trace) ||
    !Array.isArray(trace.spans)
  ) {
    throw new TypeError("Expected a persisted trace with spans");
  }
  return JSON.stringify(
    trace.spans.map((span) => {
      if (typeof span !== "object" || span === null) return span;
      return {
        type: span.type,
        name: span.name,
        attributes: span.attributes,
        metadata: span.metadata,
      };
    }),
  );
}

describe("CLI agent runtime composition", () => {
  it("accepts only supported direct-run adapter configuration", async () => {
    const encoded = createDirectRunAdapterConfiguration({
      adapter: "opencode",
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
          host: "0:0:0:0:0:0:0:1",
        }),
      ),
    ).toMatchObject({ host: "::1" });
    expect(
      JSON.parse(createDirectRunAdapterConfiguration({ adapter: "opencode" })),
    ).toEqual({
      adapter: "opencode",
      mode: "managed",
      host: "127.0.0.1",
      port: 0,
    });
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
        host: "192.168.1.1",
      }),
    ).toThrow();
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
      const runtime = await factory(
        new AbortController().signal,
        process.cwd(),
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
    const close = vi.fn(async () => undefined);
    vi.mocked(startOpenCodeService).mockResolvedValue({
      url: `http://127.0.0.1:${address.port}`,
      diagnostics: () => "",
      close,
    });

    try {
      const factory = loadDirectRunAgentRuntimeFactory({
        [directRunAdapterConfigurationEnvironment]:
          createDirectRunAdapterConfiguration({
            adapter: "opencode",
          }),
      });
      const runtime = await factory(
        new AbortController().signal,
        process.cwd(),
      );
      await runtime.close?.();

      expect(startOpenCodeService).toHaveBeenCalledWith(
        expect.objectContaining({ host: "127.0.0.1", port: 0 }),
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

  it("selects an adapter-owned ACP runtime factory", async () => {
    const runtime = await createAgentRuntimeFactory({
      adapter: "acp",
      configuration: {
        id: "fixture",
        description: "Fixture ACP runtime",
        command: "fixture-acp",
        persistSession: true,
      },
    })(new AbortController().signal, "/workspace");

    expect(runtime.identity).toBe("acp");
    expect(runtime.capabilities).toMatchObject({ sessionReuse: true });
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

  it("persists injected OpenCode adapter spans through the operational host", async () => {
    const adapter = createOpenCodeAdapterForRun({
      prompt: async ({ onObservation }) => {
        onObservation?.({
          kind: "tool",
          sessionID: "opencode-session",
          messageID: "opencode-message",
          callID: "opencode-call",
          tool: "ｅｃｈｏ",
          status: "completed",
          input: { secret: "opencode-input" },
          output: "opencode-output",
          metadata: { transcript: "opencode-transcript" },
        });
        return { structured: { value: "done" } };
      },
      checkpoint: async () => ({
        sessionId: "opencode-session",
        messageId: "opencode-message",
      }),
      fork: async () => {
        throw new Error("fork is not used by storage verification");
      },
      abort: async () => undefined,
      close: async () => undefined,
    });
    const trace = await persistedTrace(
      "repository:opencode-observability",
      adapter,
      "11111111111111111111111111111111",
    );

    expectPersistedAdapterTrace(trace, "opencode", "echo", "opencode-call");
    const serialized = serializedSpanFields(trace);
    expect(serialized).not.toContain("opencode-input");
    expect(serialized).not.toContain("opencode-output");
    expect(serialized).not.toContain("opencode-transcript");
  });

  it("persists injected ACP adapter spans through the operational host", async () => {
    const adapter = createAcpAdapter(
      parseAcpLaunchConfiguration({
        id: "storage-agent",
        description: "Storage verification agent",
        command: "storage-agent",
        persistSession: false,
      }),
      {
        createAgent: () => ({
          stream: async () => ({
            fullStream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "tool-call",
                  payload: {
                    toolCallId: "acp-call",
                    toolName: "read_file",
                    args: { secret: "acp-input" },
                  },
                });
                controller.enqueue({
                  type: "tool-result",
                  payload: {
                    toolCallId: "acp-call",
                    toolName: "read_file",
                    result: "acp-output",
                  },
                });
                controller.close();
              },
            }),
            text: Promise.resolve('{"value":"done"}'),
          }),
        }),
      },
    );
    const trace = await persistedTrace(
      "repository:acp-observability",
      adapter,
      "22222222222222222222222222222222",
    );

    expectPersistedAdapterTrace(trace, "acp-v1", "read_file", "acp-call");
    const serialized = serializedSpanFields(trace);
    expect(serialized).not.toContain("acp-input");
    expect(serialized).not.toContain("acp-output");
  });
});
