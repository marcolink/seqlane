// @test-scope ./seqlane-agent-runner.ts

import type {
  AgentAdapter,
  AgentAdapterRequest,
  AgentRuntime,
} from "@seqlane/agent-adapter";
import { openai } from "@seqlane/core/models";
import type { StartWorkflowRunRequest } from "@seqlane/runtime";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import workflow from "@seqlane/resolve-merge-conflicts-workflow";

import { createSeqlaneAgentRunner } from "./seqlane-agent-runner.js";
import { createBoundedRecording, type BoundedRecording } from "./recording.js";

type ObservationHandler = NonNullable<StartWorkflowRunRequest["onObservation"]>;

const request = {
  paths: ["src/file.ts"],
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
};
const workspace = process.cwd();

const output = {
  summary: "Resolved the file.",
  resolvedFiles: ["src/file.ts"],
  decisions: [{ file: "src/file.ts", decision: "Kept both changes." }],
};

const capabilities = {
  execute: true,
  modelSelection: true,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: false,
  fork: false,
  activity: true,
  sessionUi: false,
} as const;

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startOpenCodePeer() {
  const falseyValues = { flag: false, count: 0, text: "", absent: null };
  const provider = {
    id: "openai",
    models: {
      "gpt-6-luna": {
        id: "gpt-6-luna",
        variants: { high: { disabled: false } },
      },
    },
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/provider") {
      writeJson(response, {
        all: [provider],
        default: { openai: "gpt-6-luna" },
        connected: ["openai"],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/config/providers") {
      writeJson(response, {
        providers: [provider],
        default: { openai: "gpt-6-luna" },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/global/health") {
      writeJson(response, { healthy: true, version: "1.18.27" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      writeJson(response, { id: "session-1", directory: workspace });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/session/session-1/init"
    ) {
      writeJson(response, true);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/session/session-1/message"
    ) {
      writeJson(response, {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1, completed: 2 },
          modelID: "gpt-6-luna",
          providerID: "openai",
          cost: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "part-text",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            text: JSON.stringify(output),
          },
          {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            callID: "tool-1",
            tool: "filesystem.read",
            state: {
              status: "completed",
              input: falseyValues,
              output: "",
              metadata: falseyValues,
              time: { start: 1, end: 2 },
            },
          },
        ],
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/session/session-1/message"
    ) {
      writeJson(response, []);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/session/session-1/history"
    ) {
      writeJson(response, { data: [], hasMore: false });
      return;
    }
    if (
      request.method === "GET" &&
      [
        "/api/session/session-1/permission",
        "/api/session/session-1/question",
      ].includes(url.pathname)
    ) {
      writeJson(response, { data: [] });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/session/session-1/abort"
    ) {
      writeJson(response, true);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Controlled OpenCode peer did not expose a TCP address");
  }
  return {
    falseyValues,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function createRunner(options: {
  readonly execute: (request: AgentAdapterRequest) => Promise<unknown>;
  readonly recording?: () => BoundedRecording;
  readonly onObservation?: ObservationHandler;
  readonly attemptTimeoutMs?: number;
}) {
  const runtimeStop = vi.fn(async () => undefined);
  const adapterClose = vi.fn(async () => undefined);
  const runtimeFactoryCalls: Array<{
    readonly workspace: string;
    readonly signal: AbortSignal;
  }> = [];
  const runtimeFactory = async (
    _connection: { readonly url: string; readonly workspace?: string },
    workspace: string,
    signal: AbortSignal,
  ): Promise<AgentRuntime> => {
    runtimeFactoryCalls.push({ workspace, signal });
    const adapter: AgentAdapter = {
      capabilities,
      execute: (request) => {
        request.onExecutionStarted();
        return options.execute(request);
      },
      close: adapterClose,
    };
    return {
      identity: "opencode",
      capabilities,
      modelCapabilities: {
        executor: "opencode",
        listModels: async () => [{ provider: "openai", model: "gpt-6-luna" }],
        resolveDefaultModel: async () => ({ model: openai("gpt-6-luna") }),
        validateModelSelection: async () => undefined,
      },
      createAdapter: () => adapter,
      redactAdapter: (value) => value,
    };
  };
  const agent = createSeqlaneAgentRunner({
    workspace: workspace,
    workflow,
    pullRequestNumber: 1,
    openCode: {
      start: async () => ({
        connection: {
          url: "http://127.0.0.1:4096",
          workspace: workspace,
        },
        stop: runtimeStop,
      }),
    },
    createAgentRuntime: runtimeFactory,
    ...(options.recording === undefined
      ? {}
      : { recording: options.recording }),
    ...(options.onObservation === undefined
      ? {}
      : { onObservation: options.onObservation }),
    ...(options.attemptTimeoutMs === undefined
      ? {}
      : { attemptTimeoutMs: options.attemptTimeoutMs }),
  });
  return { agent, adapterClose, runtimeFactoryCalls, runtimeStop };
}

describe("SeqlaneAgentRunner common Effect path", () => {
  it("forwards native OpenCode model and tool observations to the Action hooks", async () => {
    const peer = await startOpenCodePeer();
    const recording = createBoundedRecording(undefined);
    const observations: unknown[] = [];
    const agent = createSeqlaneAgentRunner({
      workspace: workspace,
      workflow,
      pullRequestNumber: 1,
      openCode: {
        start: async () => ({
          connection: { url: peer.url, workspace: workspace },
          stop: peer.close,
        }),
      },
      recording: () => recording,
      onObservation: (event) => observations.push(event),
    });
    try {
      await expect(agent.resolve(request)).resolves.toEqual(output);
      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({
        type: "invocation.observation",
        state: "started",
        model: {
          request: {
            text: expect.stringContaining("src/file.ts"),
            selection: { model: { provider: "openai", model: "gpt-6-luna" } },
          },
        },
      });
      expect(observations[1]).toMatchObject({
        type: "invocation.observation",
        state: "succeeded",
        model: {
          operation: "chat",
          provider: "openai",
          model: "gpt-6-luna",
          response: { text: JSON.stringify(output) },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          cost: 0,
        },
      });
      expect(recording.events).toContainEqual(
        expect.objectContaining({
          type: "invocation.activity",
          input: { state: "present", value: peer.falseyValues },
          output: { state: "present", value: "" },
          activityMetadata: { state: "present", value: peer.falseyValues },
        }),
      );
    } finally {
      await agent.stop?.();
    }
  });

  it("runs the authored workflow through the facade and preserves complete adapter context", async () => {
    const recording = createBoundedRecording(undefined);
    const observations: unknown[] = [];
    const activityValues = {
      flag: false,
      count: 0,
      text: "",
      absent: null,
    };
    const observedModel = {
      observationId: "model-observation",
      kind: "model" as const,
      state: "succeeded" as const,
      attemptIndex: 0,
      model: {
        operation: "chat",
        provider: "openai",
        model: "gpt-6-luna",
        request: { native: activityValues },
        response: { native: activityValues },
        usage: { inputTokens: 0, outputTokens: 0 },
        cost: 0,
        startedAt: 1,
        endedAt: 2,
      },
    };
    const runner = createRunner({
      recording: () => recording,
      onObservation: (event) => observations.push(event),
      execute: async (agentRequest) => {
        agentRequest.onObservation?.(observedModel);
        agentRequest.onActivity?.({
          activityId: "controlled-tool",
          kind: "tool",
          name: "filesystem.read",
          state: "succeeded",
          input: activityValues,
          output: activityValues,
          startedAt: 1,
          endedAt: 2,
        });
        return output;
      },
    });

    await expect(runner.agent.resolve(request)).resolves.toEqual(output);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      type: "invocation.observation",
      model: {
        request: { native: activityValues },
        response: { native: activityValues },
        usage: { inputTokens: 0, outputTokens: 0 },
        cost: 0,
      },
    });
    expect(recording.events).toContainEqual(
      expect.objectContaining({
        type: "invocation.activity",
        input: { state: "present", value: activityValues },
        output: { state: "present", value: activityValues },
      }),
    );
    expect(runner.runtimeFactoryCalls).toHaveLength(1);
    expect(runner.runtimeFactoryCalls[0]).toMatchObject({
      workspace: workspace,
      signal: expect.any(AbortSignal),
    });
    expect(runner.adapterClose).toHaveBeenCalledTimes(1);
    expect(runner.runtimeStop).not.toHaveBeenCalled();
  });

  it("rejects malformed workflow output from the real run outcome", async () => {
    const runner = createRunner({
      execute: async () => ({ summary: "missing fields" }),
    });

    await expect(runner.agent.resolve(request)).rejects.toMatchObject({
      category: "agent",
      code: "AGENT_FAILED",
      message: "The Seqlane conflict-resolution task failed.",
    });
  });

  it("creates a fresh bounded recording for each attempt", async () => {
    let recordings = 0;
    const runner = createRunner({
      recording: () => {
        recordings += 1;
        return createBoundedRecording(undefined, 1, 1_024);
      },
      execute: async () => output,
    });

    await expect(runner.agent.resolve(request)).resolves.toEqual(output);
    await expect(runner.agent.resolve(request)).resolves.toEqual(output);

    expect(recordings).toBe(2);
    expect(runner.adapterClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the shared OpenCode service alive until a timed-out run settles", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const runner = createRunner({
      attemptTimeoutMs: 250,
      execute: async ({ signal }) => {
        resolveStarted();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      },
    });

    const resolution = runner.agent.resolve(request);
    await started;
    await expect(resolution).rejects.toMatchObject({
      message: "The conflict-resolution attempt exceeded its deadline.",
    });
    expect(runner.runtimeStop).not.toHaveBeenCalled();
    await runner.agent.stop?.();
    expect(runner.runtimeStop).toHaveBeenCalledTimes(1);
  });

  it("cancels active work before stopping its caller-owned OpenCode service", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const runner = createRunner({
      execute: async ({ signal }) => {
        resolveStarted();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      },
    });

    const resolution = runner.agent.resolve(request);
    await started;
    await runner.agent.stop?.();

    await expect(resolution).rejects.toMatchObject({ category: "agent" });
    expect(runner.adapterClose).toHaveBeenCalledTimes(1);
    expect(runner.runtimeStop).toHaveBeenCalledTimes(1);
  });
});
