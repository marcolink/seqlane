// @test-scope ./adapter.ts
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import {
  InteractionRequiredError,
  type AgentTaskDefinition,
  type SeqlaneInvocationMetrics,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenCodeAdapterForRun } from "./adapter.js";
import type { OpenCodePrompt, OpenCodeRun } from "./protocol.js";

const task: AgentTaskDefinition = {
  id: "agent-task",
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
  goal: ({ value }) => `Process ${value}`,
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
    signal: new AbortController().signal,
    ...overrides,
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

  it("forwards uncertain activity and background process callbacks", async () => {
    const termination = Promise.resolve();
    const uncertainActivities: unknown[] = [];
    const backgroundProcesses: unknown[] = [];
    const run = createRun(async (prompt) => {
      prompt.onUncertainActivity?.({ reason: "disconnect", termination });
      prompt.onBackgroundProcess?.({ mutatesWorkspace: true });
      return { structured: { result: "done" } };
    });
    const adapter = createOpenCodeAdapterForRun(run);

    await expect(
      adapter.execute(
        request({
          onUncertainActivity: (activity) => uncertainActivities.push(activity),
          onBackgroundProcess: (process) => backgroundProcesses.push(process),
        }),
      ),
    ).resolves.toEqual({ result: "done" });

    expect(uncertainActivities).toEqual([
      { reason: "disconnect", termination },
    ]);
    expect(backgroundProcesses).toEqual([{ mutatesWorkspace: true }]);
  });

  it("validates and repairs prompt-mode structured output", async () => {
    let attempts = 0;
    const run = createRun(
      async (prompt) => {
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
