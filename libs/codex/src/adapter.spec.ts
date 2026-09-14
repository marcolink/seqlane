// @test-scope ./adapter.ts
// @test-scope ./protocol.ts
import type {
  AgentAdapterRequest,
  AgentActivity,
} from "@seqlane/agent-adapter";
import type { ModelSelection, TaskDefinition } from "@seqlane/core";
import { InteractionRequiredError } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createCodexAdapter,
  createCodexAdapterForTransport,
} from "./adapter.js";
import type {
  CodexInboundMessage,
  CodexLaunchConfiguration,
} from "./protocol.js";
import type { CodexTransport } from "./transport.js";

const configuration: CodexLaunchConfiguration = {
  executable: "/opt/codex",
  workspace: "/workspace",
  networkAccess: false,
};

const selection: ModelSelection = {
  model: { provider: "openai", model: "gpt-5.1-codex" },
  reasoning: "high",
};

const task: TaskDefinition = {
  id: "codex-task",
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
  execute: async () => ({ result: "unused" }),
};

function request(
  overrides: Partial<AgentAdapterRequest> = {},
): AgentAdapterRequest {
  return {
    invocationId: "invocation-1",
    observability: {},
    task,
    input: { value: "demo" },
    agent: { goal: "Return the result" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

class FakeTransport implements CodexTransport {
  readonly termination = Promise.resolve();
  readonly requests: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  private readonly listeners = new Set<
    (message: CodexInboundMessage) => void
  >();
  private turnNumber = 0;
  emitCompletion = true;
  emitBeforeTurnResponse = false;
  emitMultipleAgentMessages = false;
  delayTurnStart = false;
  failInterrupt = false;
  private pendingTurnStart?: () => void;

  resolveTurnStart(): void {
    this.pendingTurnStart?.();
    this.pendingTurnStart = undefined;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "model/list") {
      return {
        data: [
          {
            id: "openai/gpt-5.1-codex",
            model: "gpt-5.1-codex",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            isDefault: true,
          },
        ],
      };
    }
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/fork") return { thread: { id: "thread-child" } };
    if (method === "turn/interrupt") {
      if (this.failInterrupt) throw new Error("interrupt was refused");
      const turnId = String((params as { readonly turnId: string }).turnId);
      setTimeout(
        () =>
          this.emit({
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: turnId, status: "interrupted", items: [] },
              },
            },
          }),
        0,
      );
      return {};
    }
    if (method === "turn/start") {
      this.turnNumber += 1;
      const turnId = `turn-${this.turnNumber}`;
      const threadId = this.requests
        .slice()
        .reverse()
        .find((value) => value.method === "turn/start")?.params as {
        readonly threadId: string;
      };
      const emitTurnEvents = (): void => {
        if (!this.emitCompletion) return;
        this.emit({
          kind: "notification",
          notification: {
            method: "item/started",
            params: {
              threadId: threadId.threadId,
              turnId,
              item: {
                id: `tool-${turnId}`,
                type: "commandExecution",
                input: { command: "true" },
              },
              startedAtMs: 1,
            },
          },
        });
        this.emit({
          kind: "notification",
          notification: {
            method: "item/completed",
            params: {
              threadId: threadId.threadId,
              turnId,
              item: {
                id: `tool-${turnId}`,
                type: "commandExecution",
                status: "completed",
                output: "ok",
              },
              completedAtMs: 2,
            },
          },
        });
        this.emit({
          kind: "notification",
          notification: {
            method: "item/agentMessage/delta",
            params: {
              threadId: threadId.threadId,
              turnId,
              itemId: `item-${turnId}`,
              delta: '{"result":"done"}',
            },
          },
        });
        if (this.emitMultipleAgentMessages) {
          this.emit({
            kind: "notification",
            notification: {
              method: "item/agentMessage/delta",
              params: {
                threadId: threadId.threadId,
                turnId,
                itemId: `other-item-${turnId}`,
                delta: '{"result":"wrong"}',
              },
            },
          });
          this.emit({
            kind: "notification",
            notification: {
              method: "item/completed",
              params: {
                threadId: threadId.threadId,
                turnId,
                item: {
                  id: `other-item-${turnId}`,
                  type: "agentMessage",
                  text: '{"result":"wrong"}',
                },
                completedAtMs: 3,
              },
            },
          });
        }
        this.emit({
          kind: "notification",
          notification: {
            method: "item/completed",
            params: {
              threadId: threadId.threadId,
              turnId,
              item: {
                id: `item-${turnId}`,
                type: "agentMessage",
                text: '{"result":"done"}',
              },
              completedAtMs: 3,
            },
          },
        });
        this.emit({
          kind: "notification",
          notification: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: threadId.threadId,
              turnId,
              tokenUsage: {
                total: {
                  totalTokens: 3,
                  inputTokens: 1,
                  cachedInputTokens: 0,
                  cacheWriteInputTokens: 0,
                  outputTokens: 2,
                  reasoningOutputTokens: 1,
                },
                last: {
                  totalTokens: 3,
                  inputTokens: 1,
                  cachedInputTokens: 0,
                  cacheWriteInputTokens: 0,
                  outputTokens: 2,
                  reasoningOutputTokens: 1,
                },
              },
            },
          },
        });
        this.emit({
          kind: "notification",
          notification: {
            method: "turn/completed",
            params: {
              threadId: threadId.threadId,
              turn: { id: turnId, status: "completed", items: [] },
            },
          },
        });
      };
      if (this.emitBeforeTurnResponse) emitTurnEvents();
      else setTimeout(emitTurnEvents, 0);
      const result = { turn: { id: turnId, status: "inProgress", items: [] } };
      if (this.delayTurnStart) {
        return new Promise((resolve) => {
          this.pendingTurnStart = () => resolve(result);
        });
      }
      return result;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  subscribe(listener: (message: CodexInboundMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  respond(): void {
    // Server-request responses are not needed by this fake.
  }

  emit(message: CodexInboundMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

describe("Codex AgentAdapter", () => {
  it("uses the shared 15-second startup and model preflight deadline", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const originalRequest = transport.request.bind(transport);
      transport.request = (method, params) =>
        method === "model/list"
          ? new Promise<never>(() => undefined)
          : originalRequest(method, params);
      let initializeTimeoutMs: number | undefined;
      const adapter = createCodexAdapter(configuration, {
        createTransport: async (_configuration, options) => {
          initializeTimeoutMs = options.initializeTimeoutMs;
          return transport;
        },
      });
      let settled = false;
      const execution = adapter.execute(request());
      void execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(5_001);
      expect(initializeTimeoutMs).toBe(15_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(9_999);
      await expect(execution).rejects.toMatchObject({
        operation: "model/list",
        message: expect.stringContaining("15000ms"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes typed output, reports activity and metrics, and forks exactly", async () => {
    const transport = new FakeTransport();
    const activities: AgentActivity[] = [];
    const metrics: unknown[] = [];
    const backgroundProcesses: unknown[] = [];
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(
      adapter.execute(
        request({
          onActivity: (value) => activities.push(value),
          onMetrics: (value) => metrics.push(value),
          onBackgroundProcess: (value) => backgroundProcesses.push(value),
        }),
      ),
    ).resolves.toEqual({ result: "done" });
    expect(backgroundProcesses).toEqual([]);
    const checkpoint = await adapter.captureCheckpoint!();
    const child = await adapter.fork!({
      checkpoint,
      modelSelection: selection,
    });
    await expect(
      child.execute(
        request({ invocationId: "child-1", modelSelection: selection }),
      ),
    ).resolves.toEqual({ result: "done" });

    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: "tool-turn-1",
          name: "commandExecution",
          state: "started",
        }),
        expect.objectContaining({
          activityId: "tool-turn-1",
          name: "commandExecution",
          state: "succeeded",
          startedAt: 1,
          input: { command: "true" },
        }),
        expect.objectContaining({
          activityId: "item-turn-1",
          state: "progress",
        }),
      ]),
    );
    expect(metrics).toHaveLength(1);
    expect(
      transport.requests.find((value) => value.method === "thread/start")
        ?.params,
    ).toEqual({
      cwd: configuration.workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      model: selection.model.model,
    });
    expect(
      transport.requests.find((value) => value.method === "turn/start")?.params,
    ).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [configuration.workspace],
        networkAccess: false,
      },
      effort: selection.reasoning,
    });
    expect(
      transport.requests.find((value) => value.method === "thread/fork")
        ?.params,
    ).toEqual({
      threadId: "thread-1",
      lastTurnId: "turn-1",
    });
  });

  it("selects the final completed agent message by item", async () => {
    const transport = new FakeTransport();
    transport.emitMultipleAgentMessages = true;
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(adapter.execute(request())).resolves.toEqual({
      result: "done",
    });
  });

  it("buffers turn events that arrive before the turn/start response", async () => {
    const transport = new FakeTransport();
    transport.emitBeforeTurnResponse = true;
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(adapter.execute(request())).resolves.toEqual({
      result: "done",
    });
  });

  it("interrupts an accepted turn when turn/start is aborted", async () => {
    const transport = new FakeTransport();
    transport.delayTurnStart = true;
    const controller = new AbortController();
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });
    const execution = adapter.execute(request({ signal: controller.signal }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    transport.resolveTurnStart();

    await expect(execution).rejects.toBeDefined();
    expect(
      transport.requests.some((value) => value.method === "turn/interrupt"),
    ).toBe(true);
  });

  it("rejects checkpoint and fork reuse after an unconfirmed interruption", async () => {
    const transport = new FakeTransport();
    const adapter = createCodexAdapterForTransport(transport, configuration);
    await expect(adapter.execute(request())).resolves.toEqual({
      result: "done",
    });
    const checkpoint = await adapter.captureCheckpoint!();

    transport.emitCompletion = false;
    transport.failInterrupt = true;
    const controller = new AbortController();
    const execution = adapter.execute(request({ signal: controller.signal }));
    for (
      let index = 0;
      index < 20 &&
      transport.requests.filter(({ method }) => method === "turn/start")
        .length < 2;
      index += 1
    ) {
      await Promise.resolve();
    }
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "cancellation" });
    await expect(adapter.captureCheckpoint!()).rejects.toThrow("invalidated");
    await expect(adapter.fork!({ checkpoint })).rejects.toThrow("invalidated");
    expect(
      transport.requests.filter(({ method }) => method === "thread/fork"),
    ).toHaveLength(0);
  });

  it("cancels adapter creation and closes a transport that resolves late", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let resolveTransport!: (transport: CodexTransport) => void;
    let closed = 0;
    const adapter = createCodexAdapter(configuration, {
      createTransport: (_configuration, options) => {
        receivedSignal = options.signal;
        return new Promise<CodexTransport>((resolve) => {
          resolveTransport = resolve;
        });
      },
    });

    const execution = adapter.execute(request({ signal: controller.signal }));
    controller.abort(new Error("fixture adapter creation cancelled"));
    await expect(execution).rejects.toThrow(
      "fixture adapter creation cancelled",
    );
    expect(receivedSignal).toBe(controller.signal);

    const transport = new FakeTransport();
    transport.close = async () => {
      closed += 1;
    };
    resolveTransport(transport);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
  });

  it("rejects unsupported providers before task execution", async () => {
    const transport = new FakeTransport();
    const adapter = createCodexAdapterForTransport(transport, configuration);
    await expect(
      adapter.execute(
        request({
          modelSelection: { model: { provider: "anthropic", model: "claude" } },
        }),
      ),
    ).rejects.toThrow('provider "anthropic" is not supported');
    expect(transport.requests).toEqual([]);
  });

  it("turns an interaction request into a non-interactive failure", async () => {
    const transport = new FakeTransport();
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });
    transport.emitCompletion = false;
    const originalRequest = transport.request.bind(transport);
    transport.request = async (method, params) => {
      if (method === "turn/start") {
        const result = await originalRequest(method, params);
        setTimeout(
          () =>
            transport.emit({
              kind: "server-request",
              request: {
                id: 99,
                method: "item/commandExecution/requestApproval",
                params: { threadId: "thread-1", turnId: "turn-1" },
              },
            }),
          0,
        );
        return result;
      }
      return originalRequest(method, params);
    };
    await expect(adapter.execute(request())).rejects.toBeInstanceOf(
      InteractionRequiredError,
    );
  });
});
