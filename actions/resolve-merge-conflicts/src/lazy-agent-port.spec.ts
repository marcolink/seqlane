// @test-scope ./lazy-agent-port.ts

import { describe, expect, it } from "vitest";

import type { AgentRunnerPort } from "@seqlane/action-merge-conflict-resolution";
import { createLazyAgentPort } from "./lazy-agent-port.js";

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
    await port.resolve({
      paths: ["src/conflict.ts"],
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    });
    await port.stop?.();
    await port.stop?.();

    expect(factoryCalls).toBe(1);
    expect(events).toEqual(["start", "resolve", "stop"]);
  });
});
