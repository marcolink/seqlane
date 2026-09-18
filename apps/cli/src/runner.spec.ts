// @test-scope ./runner.ts
import { describe, expect, it, vi } from "vitest";
import { agentRuntimeConfigurationEnvironment } from "./agent-runtime.js";

vi.mock("@seqlane/runtime/runner", () => ({
  startRunnerProcess: vi.fn(),
}));

import { createRunnerProcessOptions } from "./runner.js";

describe("CLI runner composition", () => {
  it("does not select a concrete runtime when configuration is absent", () => {
    expect(createRunnerProcessOptions({})).toEqual({});
  });

  it("defers selected runtime construction until an agent worker profile runs", () => {
    const options = createRunnerProcessOptions({
      [agentRuntimeConfigurationEnvironment]: JSON.stringify({
        adapter: "acp",
        configuration: {
          id: "fixture",
          description: "Fixture ACP runtime",
          command: "fixture-acp",
          persistSession: false,
        },
      }),
    });

    expect(options.createAgentRuntimeFactory).toEqual(expect.any(Function));
    expect(options.createAgentRuntimeFactory?.()).toEqual(expect.any(Function));
  });
});
