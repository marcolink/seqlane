// @test-scope ./seqlane-agent-runner.ts

import { describe, expect, it, vi } from "vitest";

import type { WorkflowDefinition, SeqlaneSchema } from "@seqlane/core";
import type { OpenCodeRun } from "@seqlane/opencode";
import { createOpenCodeRun } from "@seqlane/opencode";

import {
  createSeqlaneAgentRunner,
  type SeqlaneWorkflowInput,
} from "./seqlane-agent-runner.js";

vi.mock("@seqlane/opencode", async () => {
  const actual =
    await vi.importActual<typeof import("@seqlane/opencode")>(
      "@seqlane/opencode",
    );
  return { ...actual, createOpenCodeRun: vi.fn() };
});

const schema = <T>(): SeqlaneSchema<T> => ({
  parse(value: unknown): T {
    return value as T;
  },
});

const workflow: WorkflowDefinition<SeqlaneWorkflowInput, unknown> = {
  id: "runner-stop-regression",
  input: schema<SeqlaneWorkflowInput>(),
  output: schema<unknown>(),
  build: () => ({}),
};

describe("Seqlane agent runner", () => {
  it("retries runtime cleanup when the first stop rejects", async () => {
    const cleanupError = new Error("runtime cleanup failed");
    let cleanupCalls = 0;
    const runtimeStop = vi.fn(async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw cleanupError;
    });
    const runAbort = vi.fn(async () => undefined);
    const run: OpenCodeRun = {
      prompt: async () => ({ structured: undefined }),
      checkpoint: async () => ({ sessionId: "session", messageId: "message" }),
      fork: async () => run,
      abort: runAbort,
    };
    vi.mocked(createOpenCodeRun).mockResolvedValue(run);
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: async () => ({
          connection: { url: "http://127.0.0.1:4096" },
          stop: runtimeStop,
        }),
      },
    });

    await runner.start?.();
    await expect(runner.stop?.()).rejects.toBe(cleanupError);
    await expect(runner.stop?.()).resolves.toBeUndefined();

    expect(runAbort).toHaveBeenCalledTimes(2);
    expect(runtimeStop).toHaveBeenCalledTimes(2);
  });

  it("retries runtime cleanup after startup and cleanup reject", async () => {
    vi.mocked(createOpenCodeRun).mockClear();
    const startupError = new Error("run creation failed");
    const cleanupError = new Error("runtime cleanup failed");
    const lifecycleEvents: string[] = [];
    const runtimeStop = vi.fn<() => Promise<void>>();
    runtimeStop
      .mockImplementationOnce(async () => {
        lifecycleEvents.push("old-runtime-stop");
        throw cleanupError;
      })
      .mockImplementationOnce(async () => {
        lifecycleEvents.push("old-runtime-stop");
        throw cleanupError;
      })
      .mockImplementationOnce(async () => {
        lifecycleEvents.push("old-runtime-stop");
      });
    const replacementRun: OpenCodeRun = {
      prompt: async () => ({ structured: undefined }),
      checkpoint: async () => ({
        sessionId: "replacement-session",
        messageId: "replacement-message",
      }),
      fork: async () => replacementRun,
      abort: async () => undefined,
    };
    const oldRuntime = {
      connection: { url: "http://127.0.0.1:4096" },
      stop: runtimeStop,
    };
    const newRuntime = {
      connection: { url: "http://127.0.0.1:4097" },
      stop: vi.fn(async () => undefined),
    };
    const runtimeStart = vi.fn(async () => {
      lifecycleEvents.push("runtime-start");
      return runtimeStart.mock.calls.length === 1 ? oldRuntime : newRuntime;
    });
    vi.mocked(createOpenCodeRun)
      .mockRejectedValueOnce(startupError)
      .mockResolvedValueOnce(replacementRun);
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: runtimeStart,
      },
    });

    await expect(runner.start?.()).rejects.toBe(startupError);
    await expect(runner.start?.()).rejects.toBe(cleanupError);
    expect(runtimeStart).toHaveBeenCalledTimes(1);

    await expect(runner.start?.()).resolves.toBeUndefined();

    expect(runtimeStop).toHaveBeenCalledTimes(3);
    expect(runtimeStart).toHaveBeenCalledTimes(2);
    expect(createOpenCodeRun).toHaveBeenCalledTimes(2);
    expect(lifecycleEvents).toEqual([
      "runtime-start",
      "old-runtime-stop",
      "old-runtime-stop",
      "old-runtime-stop",
      "runtime-start",
    ]);
  });
});
