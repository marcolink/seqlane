// @test-scope ./seqlane-agent-runner.ts

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createFlow, type SeqlaneSchema } from "@seqlane/core";

import {
  createSeqlaneAgentRunner,
  type SeqlaneWorkflowInput,
} from "./seqlane-agent-runner.js";

const schema = <T>(): SeqlaneSchema<T> => z.custom<T>(() => true);

const workflow = createFlow<SeqlaneWorkflowInput, unknown>({
  id: "runner-stop-regression",
  input: schema<SeqlaneWorkflowInput>(),
  output: schema<unknown>(),
})
  .output({ runner: "test" })
  .define();

describe("Seqlane agent runner", () => {
  it("retries runtime cleanup when the first stop rejects", async () => {
    const cleanupError = new Error("runtime cleanup failed");
    let cleanupCalls = 0;
    const runtimeStop = vi.fn(async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw cleanupError;
    });
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

    expect(runtimeStop).toHaveBeenCalledTimes(2);
  });

  it("propagates runtime startup failures", async () => {
    const startupError = new Error("runtime startup failed");
    const runtimeStart = vi.fn(async () => {
      throw startupError;
    });
    const runner = createSeqlaneAgentRunner({
      workspace: "/tmp/agent",
      workflow,
      openCode: {
        start: runtimeStart,
      },
    });

    await expect(runner.start?.()).rejects.toBe(startupError);
    expect(runtimeStart).toHaveBeenCalledTimes(1);
  });
});
