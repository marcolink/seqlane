// @test-scope ./seqlane-agent-runner.ts

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildWorkflow,
  createOpenCodeExecutor,
  createOpenCodeRun,
  startCompiledWorkflow,
} = vi.hoisted(() => ({
  buildWorkflow: vi.fn(),
  createOpenCodeExecutor: vi.fn(),
  createOpenCodeRun: vi.fn(),
  startCompiledWorkflow: vi.fn(),
}));

vi.mock("@seqlane/core", () => {
  const createFlow = () => {
    const flow = {
      task: () => flow,
      output: () => flow,
      define: () => ({}),
    };
    return flow;
  };
  return {
    buildWorkflow,
    createFlow,
    defineTask: (definition: unknown) => definition,
    isolated: () => ({}),
  };
});
vi.mock("@seqlane/core/models", () => ({ openai: () => ({}) }));
vi.mock("@seqlane/opencode", () => ({
  createOpenCodeExecutor,
  createOpenCodeRun,
}));
vi.mock("@seqlane/runtime", () => ({
  EffectCompiler: class {
    compileWorkflow() {
      return {};
    }
  },
  startCompiledWorkflow,
}));

import { SeqlaneAgentRunner } from "./seqlane-agent-runner.js";

const request = {
  paths: ["src/file.ts"],
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
};

function runner(output: unknown) {
  buildWorkflow.mockReturnValue({
    taskDefinitions: [],
    plan: {},
    validatorDefinitions: [],
  });
  createOpenCodeRun.mockResolvedValue({ abort: vi.fn() });
  createOpenCodeExecutor.mockReturnValue({});
  startCompiledWorkflow.mockReturnValue({
    outcome: Promise.resolve({ status: "succeeded", result: output }),
  });
  return new SeqlaneAgentRunner({
    workspace: "/tmp/agent",
    workflow: {} as never,
    openCode: {
      start: async () => ({
        connection: {},
        stop: async () => undefined,
      }),
    },
  });
}

describe("SeqlaneAgentRunner output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the validated workflow output", async () => {
    const output = {
      summary: "Resolved the file.",
      resolvedFiles: ["src/file.ts"],
      decisions: [{ file: "src/file.ts", decision: "Kept both changes." }],
    };

    await expect(runner(output).resolve(request)).resolves.toEqual(output);
  });

  it("rejects malformed workflow output", async () => {
    await expect(
      runner({ summary: "missing required fields" }).resolve(request),
    ).rejects.toMatchObject({
      category: "agent",
      code: "AGENT_FAILED",
    });
  });
});
