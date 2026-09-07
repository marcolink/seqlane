// @test-scope ./lazy-agent-port.ts

import { describe, expect, it } from "vitest";

import type { AgentRunnerPort } from "@seqlane/action-merge-conflict-resolution";
import { createLazyAgentPort } from "./lazy-agent-port.js";

const resolvedOutput = {
  summary: "Resolved the conflict.",
  resolvedFiles: ["src/conflict.ts"],
  decisions: [
    { file: "src/conflict.ts", decision: "Kept the target-side change." },
  ],
};

describe("lazy Action agent port", () => {
  it("creates one runner after metadata is available and stops it once", async () => {
    const events: string[] = [];
    let factoryCalls = 0;
    const runner: AgentRunnerPort = {
      start: async () => {
        events.push("start");
      },
      resolve: async () => {
        events.push("resolve");
        return resolvedOutput;
      },
      stop: async () => {
        events.push("stop");
      },
    };
    const port = createLazyAgentPort(() => {
      factoryCalls += 1;
      return runner;
    });

    await port.start?.();
    await expect(
      port.resolve({
        paths: ["src/conflict.ts"],
        baseRevision: "a".repeat(40),
        headRevision: "b".repeat(40),
      }),
    ).resolves.toEqual(resolvedOutput);
    await port.stop?.();
    await port.stop?.();

    expect(factoryCalls).toBe(1);
    expect(events).toEqual(["start", "resolve", "stop"]);
  });

  it("retries cleanup after a rejected stop", async () => {
    const cleanupError = new Error("cleanup failed");
    let stopCalls = 0;
    const runner: AgentRunnerPort = {
      start: async () => undefined,
      resolve: async () => resolvedOutput,
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 1) throw cleanupError;
      },
    };
    const port = createLazyAgentPort(() => runner);

    await port.start?.();
    await expect(port.stop?.()).rejects.toBe(cleanupError);
    await expect(port.stop?.()).resolves.toBeUndefined();
    await port.stop?.();

    expect(stopCalls).toBe(2);
  });

  it("preserves a startup error and retries rejected startup cleanup", async () => {
    const startupError = new Error("startup failed");
    const cleanupError = new Error("cleanup failed");
    let stopCalls = 0;
    const runner: AgentRunnerPort = {
      start: async () => {
        throw startupError;
      },
      resolve: async () => resolvedOutput,
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 1) throw cleanupError;
      },
    };
    const port = createLazyAgentPort(() => runner);

    await expect(port.start?.()).rejects.toBe(startupError);
    await expect(port.stop?.()).resolves.toBeUndefined();

    expect(stopCalls).toBe(2);
  });
});
