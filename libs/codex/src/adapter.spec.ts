// @test-scope ./adapter.ts
// @test-scope ./protocol.ts
// @test-scope ./turn-tracker.ts
// @test-scope ./activity.ts
// @test-scope ./user-input-tool.ts
import type {
  AgentAdapterRequest,
  AgentActivity,
  SeqlaneObservation,
} from "@seqlane/agent-adapter";
import type { ModelSelection, TaskDefinition } from "@seqlane/core";
import { InteractionRequiredError } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MAX_TURN_ACTIVITY_EVENTS,
  MAX_TURN_ITEM_BYTES,
  MAX_TURN_ITEMS,
} from "./activity.js";
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
    task,
    input: { value: "demo" },
    agent: { goal: "Return the result" },
    signal: new AbortController().signal,
    onExecutionStarted: () => undefined,
    ...overrides,
  };
}

function containsCause(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (value instanceof AggregateError)
    return [...value.errors].some((cause) => containsCause(cause, expected));
  if (value instanceof Error && Object.hasOwn(value, "cause"))
    return containsCause(value.cause, expected);
  return false;
}

class FakeTransport implements CodexTransport {
  readonly termination: Promise<void>;
  readonly requests: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  private readonly listeners = new Set<
    (message: CodexInboundMessage) => void
  >();
  private turnNumber = 0;
  emitCompletion = true;
  failedTurnMessage: string | undefined;
  emitBeforeTurnResponse = false;
  emitMultipleAgentMessages = false;
  agentMessageText = '{"result":"done"}';
  nativeTurnFields: Record<string, unknown> = {};
  nativeUsageFields: Record<string, unknown> = {};
  nativeItemFields: Record<string, unknown> = {};
  userInputRequest: unknown;
  userInputResponse: unknown;
  completeBeforeUserInputResponse = false;
  private pendingTurnCompletion?: () => void;
  agentMessageDeltas: string[] | undefined;
  delayTurnStart = false;
  failInterrupt = false;
  completeAfterInterrupt = true;
  interruptAcknowledged = false;
  private pendingTurnStart?: () => void;
  private resolveTermination!: () => void;
  private rejectTermination!: (cause: unknown) => void;

  constructor() {
    this.termination = new Promise<void>((resolve, reject) => {
      this.resolveTermination = resolve;
      this.rejectTermination = reject;
    });
    void this.termination.catch(() => undefined);
  }

  fail(cause: unknown): void {
    this.rejectTermination(cause);
  }

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
      this.interruptAcknowledged = true;
      const turnId = String((params as { readonly turnId: string }).turnId);
      if (this.completeAfterInterrupt) {
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
      }
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
        for (const delta of this.agentMessageDeltas ?? [
          this.agentMessageText,
        ]) {
          this.emit({
            kind: "notification",
            notification: {
              method: "item/agentMessage/delta",
              params: {
                threadId: threadId.threadId,
                turnId,
                itemId: `item-${turnId}`,
                delta,
              },
            },
          });
        }
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
                text: this.agentMessageText,
                ...this.nativeItemFields,
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
                ...this.nativeUsageFields,
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
        const completeTurn = (): void => {
          this.emit({
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId: threadId.threadId,
                turn: {
                  id: turnId,
                  status:
                    this.failedTurnMessage === undefined
                      ? "completed"
                      : "failed",
                  items: [],
                  ...this.nativeTurnFields,
                  ...(this.failedTurnMessage === undefined
                    ? {}
                    : { error: { message: this.failedTurnMessage } }),
                },
              },
            },
          });
        };
        if (this.userInputRequest !== undefined) {
          if (!this.completeBeforeUserInputResponse)
            this.pendingTurnCompletion = completeTurn;
          this.emit({
            kind: "server-request",
            request: {
              id: "ask-user-1",
              method: "item/tool/call",
              params: {
                threadId: threadId.threadId,
                turnId,
                callId: "ask-user-call-1",
                namespace: null,
                tool: "ask_user",
                arguments: this.userInputRequest,
              },
            },
          });
          if (this.completeBeforeUserInputResponse) completeTurn();
        } else completeTurn();
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
    this.resolveTermination();
    return Promise.resolve();
  }

  respond = (requestId: unknown, response: unknown): void => {
    if (requestId !== "ask-user-1") return;
    this.userInputResponse = response;
    const succeeded = z
      .object({ result: z.object({ success: z.literal(true) }) })
      .safeParse(response).success;
    if (succeeded) {
      this.pendingTurnCompletion?.();
      this.pendingTurnCompletion = undefined;
    }
  };

  emit(message: CodexInboundMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

describe("Codex AgentAdapter", () => {
  it("round-trips validated ask_user answers through the native dynamic tool", async () => {
    const transport = new FakeTransport();
    transport.userInputRequest = {
      questions: [
        {
          id: "region",
          prompt: "Choose a region",
          allowFreeText: false,
          options: [
            { value: "eu-west", label: "Europe West" },
            { value: "us-east", label: "US East" },
          ],
        },
      ],
    };
    const requestUserInput = vi.fn().mockResolvedValue({
      status: "answered",
      answers: { region: "eu-west" },
    });
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(
      adapter.execute(request({ requestUserInput })),
    ).resolves.toEqual({ result: "done" });
    expect(requestUserInput).toHaveBeenCalledWith(transport.userInputRequest);
    const threadStart = transport.requests.find(
      (value) => value.method === "thread/start",
    );
    expect(threadStart?.params).toMatchObject({
      dynamicTools: [{ name: "ask_user", type: "function" }],
    });
    expect(transport.userInputResponse).toEqual({
      result: {
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              status: "answered",
              answers: { region: "eu-west" },
            }),
          },
        ],
        success: true,
      },
    });
  });

  it("interrupts the native turn when the user-input deadline expires", async () => {
    const transport = new FakeTransport();
    transport.userInputRequest = {
      questions: [{ id: "note", prompt: "Note", allowFreeText: true }],
    };
    const timeout = new Error("User input deadline expired");
    timeout.name = "UserInputTimeoutError";
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(
      adapter.execute(
        request({ requestUserInput: async () => Promise.reject(timeout) }),
      ),
    ).rejects.toBe(timeout);

    expect(transport.interruptAcknowledged).toBe(true);
    expect(transport.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    expect(transport.userInputResponse).toMatchObject({
      result: { success: false },
    });
  });

  it("fails completion with a pending ask_user call and drops its late answer", async () => {
    const transport = new FakeTransport();
    transport.userInputRequest = {
      questions: [{ id: "note", prompt: "Note", allowFreeText: true }],
    };
    transport.completeBeforeUserInputResponse = true;
    let resolveAnswer!: (answer: {
      status: "answered";
      answers: Record<string, string>;
    }) => void;
    const lateAnswer = new Promise<{
      status: "answered";
      answers: Record<string, string>;
    }>((resolve) => {
      resolveAnswer = resolve;
    });
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    const execution = adapter.execute(
      request({ requestUserInput: async () => lateAnswer }),
    );
    await expect(execution).rejects.toMatchObject({
      code: "USER_INPUT_PROTOCOL_ERROR",
    });
    resolveAnswer({ status: "answered", answers: { note: "late" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.userInputResponse).toBeUndefined();
  });

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
    const observations: SeqlaneObservation[] = [];
    const backgroundProcesses: unknown[] = [];
    let executionStarted = 0;
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(
      adapter.execute(
        request({
          onActivity: (value) => activities.push(value),
          onMetrics: (value) => metrics.push(value),
          onObservation: (value) => observations.push(value),
          onBackgroundProcess: (value) => backgroundProcesses.push(value),
          onExecutionStarted: () => {
            executionStarted += 1;
          },
        }),
      ),
    ).resolves.toEqual({ result: "done" });
    expect(executionStarted).toBe(1);
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
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      observationId: "invocation-1:model:0",
      kind: "model",
      state: "started",
      attemptIndex: 0,
      model: {
        operation: "chat",
        provider: "openai",
        model: "gpt-5.1-codex",
        request: {
          threadId: "thread-1",
          input: [
            {
              type: "text",
              text: expect.stringContaining("Return the result"),
            },
          ],
          cwd: "/workspace",
          approvalPolicy: "never",
          outputSchema: expect.any(Object),
          sandboxPolicy: { networkAccess: false },
        },
      },
    });
    expect(observations[1]).toMatchObject({
      observationId: "invocation-1:model:0",
      kind: "model",
      state: "succeeded",
      model: {
        responseId: "turn-1",
        response: {
          text: '{"result":"done"}',
          items: expect.arrayContaining([
            expect.objectContaining({
              type: "commandExecution",
              output: "ok",
            }),
          ]),
        },
        usage: {
          total: { inputTokens: 1, outputTokens: 2 },
          last: { cachedInputTokens: 0, reasoningOutputTokens: 1 },
        },
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
      },
      availability: [
        { path: "model.response.cost", reason: "source-unavailable" },
      ],
    });
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

  it.each([2_048, MAX_TURN_ACTIVITY_EVENTS + 100])(
    "returns the final result after %i fragments mixed with tool activity",
    async (fragmentCount) => {
      const transport = new FakeTransport();
      transport.agentMessageDeltas = [
        ..." ".repeat(fragmentCount),
        '{"result":"done"}',
      ];
      const activities: AgentActivity[] = [];
      const observations: SeqlaneObservation[] = [];
      const adapter = createCodexAdapterForTransport(transport, configuration, {
        modelSelection: selection,
      });

      await expect(
        adapter.execute(
          request({
            onActivity: (activity) => activities.push(activity),
            onObservation: (observation) => observations.push(observation),
          }),
        ),
      ).resolves.toEqual({ result: "done" });
      const response = z
        .object({
          model: z.object({
            response: z.object({
              native: z.object({
                messageDeltas: z.array(z.object({ delta: z.string() })),
              }),
            }),
          }),
        })
        .parse(observations.at(-1));
      expect(
        response.model.response.native.messageDeltas.map(({ delta }) => delta),
      ).toEqual(transport.agentMessageDeltas);
      const eventCount = fragmentCount + 3;
      expect(activities).toHaveLength(
        Math.min(eventCount, MAX_TURN_ACTIVITY_EVENTS + 1),
      );
      expect(activities.at(-1)?.metadata).toEqual(
        eventCount > MAX_TURN_ACTIVITY_EVENTS ? { truncated: true } : undefined,
      );
      expect(
        transport.requests.some(({ method }) => method === "turn/interrupt"),
      ).toBe(false);
    },
  );

  it.each([0, MAX_TURN_ACTIVITY_EVENTS + 100])(
    "rejects oversized message text after %i small fragments",
    async (fragmentCount) => {
      const transport = new FakeTransport();
      transport.agentMessageDeltas = [
        ..." ".repeat(fragmentCount),
        "a".repeat(MAX_TURN_ITEM_BYTES + 1),
      ];
      const adapter = createCodexAdapterForTransport(transport, configuration, {
        modelSelection: selection,
      });

      await expect(adapter.execute(request())).rejects.toMatchObject({
        code: "limit",
      });
      expect(
        transport.requests.some(({ method }) => method === "turn/interrupt"),
      ).toBe(true);
    },
  );

  it("preserves deadline cancellation after activity truncation", async () => {
    const transport = new FakeTransport();
    transport.agentMessageDeltas = [
      ..." ".repeat(MAX_TURN_ACTIVITY_EVENTS + 1),
    ];
    const controller = new AbortController();
    const activities: AgentActivity[] = [];
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(
      adapter.execute(
        request({
          signal: controller.signal,
          onActivity: (activity) => {
            activities.push(activity);
            if (
              z
                .object({ truncated: z.literal(true) })
                .safeParse(activity.metadata).success
            )
              controller.abort(new Error("task deadline expired"));
          },
        }),
      ),
    ).rejects.toThrow("task deadline expired");
    expect(activities.at(-1)?.metadata).toEqual({ truncated: true });
    expect(
      transport.requests.some(({ method }) => method === "turn/interrupt"),
    ).toBe(true);
  });

  it("enforces the completed-item limit after activity truncation", async () => {
    const transport = new FakeTransport();
    transport.agentMessageDeltas = [
      ..." ".repeat(MAX_TURN_ACTIVITY_EVENTS + 1),
    ];
    transport.nativeTurnFields = {
      items: Array.from({ length: MAX_TURN_ITEMS }, (_, index) => ({
        id: `extra-${index}`,
        type: "commandExecution",
      })),
    };
    const activities: AgentActivity[] = [];
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(
      adapter.execute(
        request({
          onActivity: (activity) => activities.push(activity),
        }),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "limit" }),
        ]),
      }),
    });
    expect(activities.at(-1)?.metadata).toEqual({ truncated: true });
    expect(
      transport.requests.some(({ method }) => method === "turn/interrupt"),
    ).toBe(true);
  });

  it("reports the Codex error message for a failed turn", async () => {
    const transport = new FakeTransport();
    transport.failedTurnMessage = "Model request was rejected";
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(adapter.execute(request())).rejects.toThrow(
      "Codex turn failed: Model request was rejected",
    );
  });

  it("retains native response and usage when structured output is invalid", async () => {
    const transport = new FakeTransport();
    transport.agentMessageText = '{"result":false}';
    transport.nativeTurnFields = {
      nativeTurn: { enabled: false, count: 0, label: "" },
    };
    transport.nativeUsageFields = {
      nativeUsage: { enabled: false, count: 0, label: "" },
    };
    transport.nativeItemFields = {
      nativeItem: { enabled: false, count: 0, label: "" },
    };
    const observations: SeqlaneObservation[] = [];
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });

    await expect(
      adapter.execute(
        request({ onObservation: (value) => observations.push(value) }),
      ),
    ).rejects.toThrow("Codex output did not satisfy the task schema");

    expect(observations).toHaveLength(2);
    expect(observations[1]).toEqual(
      expect.objectContaining({
        observationId: "invocation-1:model:0",
        state: "failed",
        model: expect.objectContaining({
          responseId: "turn-1",
          response: expect.objectContaining({
            nativeTurn: { enabled: false, count: 0, label: "" },
            items: expect.arrayContaining([
              expect.objectContaining({
                nativeItem: { enabled: false, count: 0, label: "" },
              }),
            ]),
          }),
          usage: expect.objectContaining({
            nativeUsage: { enabled: false, count: 0, label: "" },
          }),
        }),
      }),
    );
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

  it("preserves cancellation when completion follows abort", async () => {
    const transport = new FakeTransport();
    transport.emitCompletion = false;
    const controller = new AbortController();
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });
    const execution = adapter.execute(request({ signal: controller.signal }));

    for (
      let index = 0;
      index < 20 &&
      !transport.requests.some((value) => value.method === "turn/start");
      index += 1
    ) {
      await Promise.resolve();
    }
    controller.abort(new Error("task deadline expired"));
    transport.emit({
      kind: "notification",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      },
    });

    await expect(execution).rejects.toThrow("task deadline expired");
  });

  it("fails an active turn with the transport termination cause", async () => {
    const transport = new FakeTransport();
    transport.emitCompletion = false;
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });
    const execution = adapter.execute(request());

    for (
      let index = 0;
      index < 20 &&
      !transport.requests.some((value) => value.method === "turn/start");
      index += 1
    ) {
      await Promise.resolve();
    }
    const cause = new Error("Codex app-server exited unexpectedly");
    transport.fail(cause);

    await expect(execution).rejects.toBe(cause);
  });

  it("observes partial native items and usage when transport fails", async () => {
    const transport = new FakeTransport();
    transport.emitCompletion = false;
    const observations: SeqlaneObservation[] = [];
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });
    const execution = adapter.execute(
      request({ onObservation: (value) => observations.push(value) }),
    );

    for (
      let index = 0;
      index < 20 &&
      !transport.requests.some((value) => value.method === "turn/start");
      index += 1
    ) {
      await Promise.resolve();
    }
    transport.emit({
      kind: "notification",
      notification: {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-partial",
            type: "commandExecution",
            input: { command: "echo partial" },
            nativeItem: { enabled: false, count: 0, label: "" },
          },
          startedAtMs: 10,
        },
      },
    });
    transport.emit({
      kind: "notification",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-partial",
          delta: '{"result":',
          nativeDelta: { enabled: false, count: 0, label: "" },
        },
      },
    });
    transport.emit({
      kind: "notification",
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            nativeUsage: { enabled: false, count: 0, label: "" },
          },
        },
      },
    });
    const cause = new Error("Codex app-server exited unexpectedly");
    transport.fail(cause);

    await expect(execution).rejects.toBe(cause);
    expect(observations).toHaveLength(2);
    expect(observations[1]).toMatchObject({
      observationId: "invocation-1:model:0",
      state: "failed",
      model: {
        responseId: "turn-1",
        response: {
          id: "turn-1",
          status: "inProgress",
          items: [
            {
              id: "tool-partial",
              input: { command: "echo partial" },
              nativeItem: { enabled: false, count: 0, label: "" },
            },
          ],
          messageDeltas: [
            {
              itemId: "message-partial",
              delta: '{"result":',
              nativeDelta: { enabled: false, count: 0, label: "" },
            },
          ],
        },
        usage: {
          nativeUsage: { enabled: false, count: 0, label: "" },
        },
      },
    });
  });

  it.each([
    new Error("Codex app-server failed to exit"),
    false,
    0,
    null,
    undefined,
  ])(
    "preserves termination failure %s after interrupt acknowledgement",
    async (terminationCause) => {
      const transport = new FakeTransport();
      transport.emitCompletion = false;
      transport.completeAfterInterrupt = false;
      const controller = new AbortController();
      const activities: AgentActivity[] = [];
      const adapter = createCodexAdapterForTransport(transport, configuration, {
        modelSelection: selection,
      });
      const cancellationCause = new Error("task cancelled");
      const execution = adapter.execute(
        request({
          signal: controller.signal,
          onActivity: (activity) => activities.push(activity),
        }),
      );

      for (
        let index = 0;
        index < 20 &&
        !transport.requests.some((value) => value.method === "turn/start");
        index += 1
      ) {
        await Promise.resolve();
      }
      transport.emit({
        kind: "notification",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "tool-open",
              type: "commandExecution",
              input: { command: "sleep 60" },
            },
            startedAtMs: 10,
          },
        },
      });
      controller.abort(cancellationCause);
      for (
        let index = 0;
        index < 20 && !transport.interruptAcknowledged;
        index += 1
      ) {
        await Promise.resolve();
      }
      await Promise.resolve();
      expect(transport.interruptAcknowledged).toBe(true);
      expect(activities.map((activity) => activity.state)).toEqual(["started"]);

      transport.fail(terminationCause);
      let rejection: unknown;
      try {
        await execution;
      } catch (cause) {
        rejection = cause;
      }
      expect(rejection).toMatchObject({ code: "cancellation" });
      if (!(rejection instanceof Error)) {
        throw new Error("Codex cancellation rejection was not an Error");
      }
      let cause: unknown = rejection.cause;
      while (cause instanceof Error && !(cause instanceof AggregateError)) {
        cause = cause.cause;
      }
      expect(cause).toBeInstanceOf(AggregateError);
      if (!(cause instanceof AggregateError)) {
        throw new Error("Codex cancellation did not retain its causes");
      }
      expect(cause.errors).toEqual([cancellationCause, terminationCause]);
      expect(activities.map((activity) => activity.state)).toEqual([
        "started",
        "failed",
      ]);
    },
  );

  it("fails tool activity left open when a completed turn omits item completion", async () => {
    const transport = new FakeTransport();
    transport.emitCompletion = false;
    const activities: AgentActivity[] = [];
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });
    const execution = adapter.execute(
      request({ onActivity: (activity) => activities.push(activity) }),
    );

    for (
      let index = 0;
      index < 20 &&
      !transport.requests.some((value) => value.method === "turn/start");
      index += 1
    ) {
      await Promise.resolve();
    }
    transport.emit({
      kind: "notification",
      notification: {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-open",
            type: "commandExecution",
            input: { command: "sleep 60" },
          },
          startedAtMs: 10,
        },
      },
    });
    transport.emit({
      kind: "notification",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "message-1",
                type: "agentMessage",
                text: '{"result":"done"}',
              },
            ],
          },
        },
      },
    });

    await expect(execution).resolves.toEqual({ result: "done" });
    expect(activities.map((activity) => activity.state)).toEqual([
      "started",
      "failed",
    ]);
  });

  it("fails open tool activity after confirmed turn interruption", async () => {
    const transport = new FakeTransport();
    transport.emitCompletion = false;
    const controller = new AbortController();
    const activities: AgentActivity[] = [];
    const adapter = createCodexAdapterForTransport(transport, configuration, {
      modelSelection: selection,
    });
    const cause = new Error("cancel after tool start");
    const execution = adapter.execute(
      request({
        signal: controller.signal,
        onActivity: (activity) => activities.push(activity),
      }),
    );

    for (
      let index = 0;
      index < 20 &&
      !transport.requests.some((value) => value.method === "turn/start");
      index += 1
    ) {
      await Promise.resolve();
    }
    transport.emit({
      kind: "notification",
      notification: {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-open",
            type: "commandExecution",
            input: { command: "sleep 60" },
          },
          startedAtMs: 10,
        },
      },
    });
    for (let index = 0; index < 20 && activities.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      activityId: "tool-open",
      state: "started",
      input: { command: "sleep 60" },
      startedAt: 10,
    });

    controller.abort(cause);
    await expect(execution).rejects.toBe(cause);
    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({
      activityId: "tool-open",
      state: "failed",
      input: { command: "sleep 60" },
      startedAt: 10,
      endedAt: expect.any(Number),
    });
    expect(activities[1]).not.toHaveProperty("output");
  });

  it.each([
    ["frozen Error", Object.freeze(new Error("activity sink failed"))],
    ["primitive", "activity sink failed"],
    ["null", null],
    ["undefined", undefined],
  ])(
    "interrupts the live native turn after the %s activity sink fails",
    async (_label, cause) => {
      const transport = new FakeTransport();
      transport.emitCompletion = false;
      const adapter = createCodexAdapterForTransport(transport, configuration, {
        modelSelection: selection,
      });
      const terminal = new Error("terminal activity sink failed");
      const execution = adapter.execute(
        request({
          onActivity: (activity) => {
            throw activity.state === "started" ? cause : terminal;
          },
        }),
      );
      for (
        let index = 0;
        index < 20 &&
        !transport.requests.some((value) => value.method === "turn/start");
        index += 1
      )
        await Promise.resolve();
      transport.emit({
        kind: "notification",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "sink-tool",
              type: "commandExecution",
              input: { command: "sleep 60" },
            },
            startedAtMs: 10,
          },
        },
      });
      const outcome = await execution.then(
        () => ({ fulfilled: true as const }),
        (failure: unknown) => ({ fulfilled: false as const, failure }),
      );
      expect(transport.interruptAcknowledged).toBe(true);
      expect(outcome.fulfilled).toBe(false);
      if (outcome.fulfilled) throw new Error("Codex unexpectedly succeeded");
      expect(containsCause(outcome.failure, cause)).toBe(true);
      expect(containsCause(outcome.failure, terminal)).toBe(true);
      await adapter.close?.();
    },
  );

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

  it.each([0, MAX_TURN_ACTIVITY_EVENTS + 1])(
    "rejects an approval request after %i activity fragments",
    async (fragmentCount) => {
      const transport = new FakeTransport();
      const adapter = createCodexAdapterForTransport(transport, configuration, {
        modelSelection: selection,
      });
      transport.emitCompletion = false;
      const originalRequest = transport.request.bind(transport);
      transport.request = async (method, params) => {
        if (method === "turn/start") {
          const result = await originalRequest(method, params);
          setTimeout(() => {
            for (let index = 0; index < fragmentCount; index += 1) {
              transport.emit({
                kind: "notification",
                notification: {
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: "thread-1",
                    turnId: "turn-1",
                    itemId: "message",
                    delta: " ",
                  },
                },
              });
            }
            transport.emit({
              kind: "server-request",
              request: {
                id: 99,
                method: "item/commandExecution/requestApproval",
                params: { threadId: "thread-1", turnId: "turn-1" },
              },
            });
          }, 0);
          return result;
        }
        return originalRequest(method, params);
      };
      await expect(adapter.execute(request())).rejects.toBeInstanceOf(
        InteractionRequiredError,
      );
    },
  );
});
