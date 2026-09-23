// @test-scope ./runner.ts
import { describe, expect, it, vi } from "vitest";
import {
  agentRuntimeConfigurationEnvironment,
  directRunAdapterConfigurationEnvironment,
} from "./agent-runtime.js";
import {
  classifierApiKeyEnvironment,
  classifierModelEnvironment,
  classifierUrlEnvironment,
} from "./classifier-environment.js";

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
        adapter: "codex",
      }),
    });

    expect(options.createAgentRuntimeFactory).toEqual(expect.any(Function));
    expect(options.createAgentRuntimeFactory?.()).toEqual(expect.any(Function));
  });

  it("prefers direct-run selection over inherited hosted configuration", () => {
    const options = createRunnerProcessOptions({
      [agentRuntimeConfigurationEnvironment]: JSON.stringify({
        adapter: "codex",
      }),
      [directRunAdapterConfigurationEnvironment]: JSON.stringify({
        adapter: "codex",
      }),
    });

    expect(options.createAgentRuntimeFactory?.()).toEqual(expect.any(Function));
  });

  it("captures and removes classifier startup values before workflow loading", () => {
    const environment: NodeJS.ProcessEnv = {
      [classifierUrlEnvironment]: "https://classifier.example/v1/systemone",
      [classifierModelEnvironment]: "jev-latest",
      [classifierApiKeyEnvironment]: "private-token",
    };

    const options = createRunnerProcessOptions(environment);

    expect(options.classifierConnection).toEqual({
      url: "https://classifier.example/v1/systemone",
      model: "jev-latest",
      apiKey: "private-token",
    });
    expect(environment).not.toHaveProperty(classifierUrlEnvironment);
    expect(environment).not.toHaveProperty(classifierModelEnvironment);
    expect(environment).not.toHaveProperty(classifierApiKeyEnvironment);
    expect(options.createAgentRuntimeFactory).toBeUndefined();
  });
});
