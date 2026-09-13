// @test-scope ./adapter.ts
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import {
  InteractionRequiredError,
  type AgentTaskRequest,
  type TaskDefinition,
  type SeqlaneInvocationMetrics,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createOpenCodeAdapter,
  createOpenCodeAdapterForRun,
} from "./adapter.js";
import type { OpenCodePrompt, OpenCodeRun } from "./protocol.js";
import { createOpenCodeRun } from "./session.js";

vi.mock("./session.js", () => ({
  createOpenCodeRun: vi.fn(),
}));

const task: TaskDefinition = {
  id: "agent-task",
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
  execute: async () => ({ result: "done" }),
};
const agent: AgentTaskRequest = {
  goal: "Process demo",
  instructions: ["Keep the change small"],
  references: ["AGENTS.md"],
};

function request(
  overrides: Partial<AgentAdapterRequest> = {},
): AgentAdapterRequest {
  return {
    invocationId: "invocation-1",
    task,
    input: { value: "demo" },
    agent,
    signal: new AbortController().signal,
    ...overrides,
    observability: overrides.observability ?? {},
  };
}

function createRun(
  prompt: OpenCodeRun["prompt"],
  selection?: OpenCodeRun["structuredOutput"] extends undefined
    ? never
    : NonNullable<OpenCodeRun["structuredOutput"]>,
): OpenCodeRun {
  return {
    prompt,
    checkpoint: async () => ({
      sessionId: "session-1",
      messageId: "message-1",
    }),
    fork: async () => {
      throw new Error("fork is not used by adapter execution tests");
    },
    abort: async () => undefined,
    ...(selection === undefined ? {} : { structuredOutput: selection }),
  };
}

describe("OpenCode AgentAdapter", () => {
  it("returns SDK structured output and maps activity and metrics", async () => {
    const activities: unknown[] = [];
    const metrics: SeqlaneInvocationMetrics[] = [];
    const prompts: OpenCodePrompt[] = [];
    const run = createRun(async (prompt) => {
      prompts.push(prompt);
      prompt.onActivity?.({
        activityId: "call-1",
        kind: "tool",
        name: "filesystem.read",
        state: "succeeded",
        output: "ok",
        metadata: { private: true },
        startedAt: 1,
        endedAt: 2,
      });
      return {
        structured: { result: "done" },
        metrics: {
          durationMs: 12,
          model: "fake-model",
          provider: "fake-provider",
          cost: 0,
          tokens: {
            total: 1,
            input: 1,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      };
    });
    const adapter = createOpenCodeAdapterForRun(run);

    await expect(
      adapter.execute(
        request({
          onActivity: (activity) => activities.push(activity),
          onMetrics: (value) => metrics.push(value),
        }),
      ),
    ).resolves.toEqual({ result: "done" });

    expect(prompts[0]?.text).toContain("Process demo");
    expect(prompts[0]?.text).toContain(
      "Task instruction: Keep the change small",
    );
    expect(prompts[0]?.selection).toBeUndefined();
    expect(activities).toEqual([
      {
        activityId: "call-1",
        kind: "tool",
        name: "filesystem.read",
        state: "succeeded",
        output: "ok",
        metadata: { private: true },
        startedAt: 1,
        endedAt: 2,
      },
    ]);
    expect(metrics).toHaveLength(1);
  });

  it("forwards uncertain activity callbacks", async () => {
    const termination = Promise.resolve();
    const uncertainActivities: unknown[] = [];
    const run = createRun(async (prompt) => {
      prompt.onUncertainActivity?.({ reason: "disconnect", termination });
      return { structured: { result: "done" } };
    });
    const adapter = createOpenCodeAdapterForRun(run);

    await expect(
      adapter.execute(
        request({
          onUncertainActivity: (activity) => uncertainActivities.push(activity),
        }),
      ),
    ).resolves.toEqual({ result: "done" });

    expect(uncertainActivities).toEqual([
      { reason: "disconnect", termination },
    ]);
  });

  it("cancels pending session creation with the invocation signal", async () => {
    vi.clearAllMocks();
    const runtimeController = new AbortController();
    const invocationController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(createOpenCodeRun).mockImplementationOnce(
      (_connection, signal) => {
        receivedSignal = signal;
        return new Promise<OpenCodeRun>((_resolve, reject) => {
          const onAbort = () => reject(new Error("session creation cancelled"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    );
    const adapter = createOpenCodeAdapter(
      { url: "http://opencode.test" },
      { signal: runtimeController.signal },
    );

    const execution = adapter.execute(
      request({ signal: invocationController.signal }),
    );
    expect(receivedSignal).toBeDefined();
    invocationController.abort();

    await expect(execution).rejects.toThrow("session creation cancelled");
    expect(receivedSignal?.aborted).toBe(true);
    expect(runtimeController.signal.aborted).toBe(false);
  });

  it("replaces a cached run after cancellation before the next invocation", async () => {
    vi.clearAllMocks();
    const firstController = new AbortController();
    let resolvePromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    const cancelledRun = createRun(
      (prompt) =>
        new Promise<never>((_resolve, reject) => {
          resolvePromptStarted();
          prompt.signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
    );
    const replacementRun = createRun(async () => ({
      structured: { result: "replacement" },
    }));
    vi.mocked(createOpenCodeRun)
      .mockResolvedValueOnce(cancelledRun)
      .mockResolvedValueOnce(replacementRun);
    const adapter = createOpenCodeAdapter({ url: "http://opencode.test" });

    const cancelled = adapter.execute(
      request({ signal: firstController.signal }),
    );
    await promptStarted;
    firstController.abort(new Error("cancelled by caller"));
    await expect(cancelled).rejects.toThrow("cancelled");

    await expect(adapter.execute(request())).resolves.toEqual({
      result: "replacement",
    });
    expect(createOpenCodeRun).toHaveBeenCalledTimes(2);
  });

  it("reuses a replacement run after interaction invalidation", async () => {
    vi.clearAllMocks();
    const invalidatedRun = createRun(async (prompt) => {
      prompt.onRunInvalidated?.();
      throw new InteractionRequiredError("user-input");
    });
    const replacementRun = createRun(async () => ({
      structured: { result: "replacement" },
    }));
    vi.mocked(createOpenCodeRun)
      .mockResolvedValueOnce(invalidatedRun)
      .mockResolvedValueOnce(replacementRun);
    const adapter = createOpenCodeAdapter({ url: "http://opencode.test" });

    await expect(adapter.execute(request())).rejects.toMatchObject({
      name: "InteractionRequiredError",
    });
    await expect(adapter.execute(request())).resolves.toEqual({
      result: "replacement",
    });
    expect(createOpenCodeRun).toHaveBeenCalledTimes(2);
  });

  it("recreates a forked run after cancellation before reuse", async () => {
    const cancelledChild = createRun(
      (prompt) =>
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new Error("cancelled"));
          if (prompt.signal?.aborted) onAbort();
          else
            prompt.signal?.addEventListener("abort", onAbort, { once: true });
        }),
    );
    const replacementChild = createRun(async () => ({
      structured: { result: "replacement" },
    }));
    const parent = {
      ...createRun(async () => ({ structured: { result: "parent" } })),
      fork: vi
        .fn<OpenCodeRun["fork"]>()
        .mockResolvedValueOnce(cancelledChild)
        .mockResolvedValueOnce(replacementChild),
    } satisfies OpenCodeRun;
    const adapter = createOpenCodeAdapterForRun(parent);
    const forked = await adapter.fork?.({
      checkpoint: { sessionId: "session-1", messageId: "message-1" },
    });
    if (forked === undefined) throw new Error("Forked adapter was not created");
    const controller = new AbortController();
    const cancelled = forked.execute(request({ signal: controller.signal }));
    controller.abort();

    await expect(cancelled).rejects.toThrow("cancelled");
    await expect(forked.execute(request())).resolves.toEqual({
      result: "replacement",
    });
    expect(parent.fork).toHaveBeenCalledTimes(2);
  });

  it("validates and repairs prompt-mode structured output", async () => {
    let attempts = 0;
    const run = createRun(
      async () => {
        attempts += 1;
        return attempts === 1
          ? { structured: undefined, text: "not json" }
          : { structured: undefined, text: '{"result":"repaired"}' };
      },
      async () => ({ strategy: "prompt", retryCount: 1, reason: "explicit" }),
    );
    const adapter = createOpenCodeAdapterForRun(run);

    await expect(adapter.execute(request())).resolves.toEqual({
      result: "repaired",
    });
    expect(attempts).toBe(2);
  });

  it("passes cancellation to the SDK-backed session prompt", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let resolvePromptCalled!: () => void;
    const promptCalled = new Promise<void>((resolve) => {
      resolvePromptCalled = resolve;
    });
    const run = createRun(async (prompt) => {
      receivedSignal = prompt.signal;
      resolvePromptCalled();
      return new Promise<never>((_resolve, reject) => {
        prompt.signal?.addEventListener(
          "abort",
          () => reject(prompt.signal?.reason ?? new Error("cancelled")),
          { once: true },
        );
      });
    });
    const adapter = createOpenCodeAdapterForRun(run);
    const execution = adapter.execute(request({ signal: controller.signal }));

    await promptCalled;
    controller.abort(new Error("cancelled by caller"));
    await expect(execution).rejects.toThrow("cancelled");
    expect(receivedSignal).toBe(controller.signal);
  });

  it("preserves unresolved interaction failures without approving them", async () => {
    const run = createRun(async () => {
      throw new InteractionRequiredError("user-input");
    });
    const adapter = createOpenCodeAdapterForRun(run);

    await expect(adapter.execute(request())).rejects.toMatchObject({
      name: "InteractionRequiredError",
      requirement: "user-input",
    });
  });

  it("exposes the adapter-owned session UI and native session capabilities", async () => {
    const run = createRun(async () => ({ structured: { result: "done" } }));
    const adapter = createOpenCodeAdapterForRun({
      ...run,
      browserUrl: "http://127.0.0.1:4096/session/session-1",
    });

    expect(adapter.capabilities).toEqual({
      execute: true,
      modelSelection: true,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: true,
      sessionUi: true,
    });
    await expect(adapter.sessionUi?.()).resolves.toBe(
      "http://127.0.0.1:4096/session/session-1",
    );
    await expect(adapter.captureCheckpoint?.()).resolves.toEqual({
      sessionId: "session-1",
      messageId: "message-1",
    });
  });
});
