// @test-scope ./seqlane-agent-runner.ts

import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildWorkflow, createOpenCodeAdapter, startCompiledWorkflow } =
  vi.hoisted(() => ({
    buildWorkflow: vi.fn(),
    createOpenCodeAdapter: vi.fn(),
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
  createOpenCodeAdapter,
}));
vi.mock("@seqlane/runtime", () => ({
  PlanCompiler: class {
    compileWorkflow() {
      return {};
    }
  },
  startCompiledWorkflow,
}));

import { SeqlaneAgentRunner } from "./seqlane-agent-runner.js";
import { createBoundedRecording } from "./recording.js";

const request = {
  paths: ["src/file.ts"],
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
};

function runner(
  output: unknown,
  recording?: () => ReturnType<typeof createBoundedRecording>,
) {
  buildWorkflow.mockReturnValue({
    taskDefinitions: [],
    plan: {},
    validatorDefinitions: [],
  });
  createOpenCodeAdapter.mockReturnValue({ execute: vi.fn() });
  startCompiledWorkflow.mockReturnValue({
    outcome: Promise.resolve({ status: "succeeded", result: output }),
  });
  return new SeqlaneAgentRunner({
    workspace: "/tmp/agent",
    workflow: {} as never,
    openCode: {
      start: async () => ({
        connection: { url: "http://127.0.0.1:4096" },
        stop: async () => undefined,
      }),
    },
    recording,
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

  it("rejects output that does not exactly cover requested conflict paths", async () => {
    await expect(
      runner({
        summary: "Resolved the file.",
        resolvedFiles: ["src/file.ts", "src/extra.ts"],
        decisions: [
          { file: "src/file.ts", decision: "Resolved." },
          { file: "src/extra.ts", decision: "Unexpected." },
        ],
      }).resolve(request),
    ).rejects.toMatchObject({
      category: "agent",
      code: "AGENT_FAILED",
    });
  });

  it("creates an independently bounded recording for each agent attempt", async () => {
    let recordings = 0;
    const agent = runner(outputForRequest(), () => {
      recordings += 1;
      return createBoundedRecording(undefined, 1, 1_024);
    });

    await agent.resolve(request);
    expect(agent.getAttemptDiagnostics?.()).toEqual({
      eventCount: 0,
      truncated: false,
    });
    await agent.resolve(request);

    expect(recordings).toBe(2);
  });
});

function outputForRequest() {
  return {
    summary: "Resolved the file.",
    resolvedFiles: ["src/file.ts"],
    decisions: [{ file: "src/file.ts", decision: "Kept both changes." }],
  };
}
