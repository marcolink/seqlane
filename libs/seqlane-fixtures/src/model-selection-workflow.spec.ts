// @test-scope ./model-selection-workflow.ts
import { buildWorkflow } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import {
  MODEL_SELECTION_INVOCATIONS,
  modelSelectionWorkflow,
} from "./model-selection-workflow.js";

describe("model-selection workflow fixture", () => {
  it("covers isolated, reuse, and distinct branched child selections", () => {
    const plan = buildWorkflow(modelSelectionWorkflow).plan;
    const tasks = plan.nodes.filter((node) => node.type === "task");

    expect(tasks.map(({ taskId }) => taskId)).toEqual([
      MODEL_SELECTION_INVOCATIONS.isolated,
      MODEL_SELECTION_INVOCATIONS.source,
      MODEL_SELECTION_INVOCATIONS.reuse,
      MODEL_SELECTION_INVOCATIONS.branch,
      MODEL_SELECTION_INVOCATIONS.child,
    ]);
    expect(tasks.map((node) => node.session)).toEqual([
      {
        type: "isolated",
        model: {
          model: { provider: "openai", model: "gpt-5.6-sol" },
          reasoning: "medium",
        },
      },
      {
        type: "isolated",
        model: {
          model: { provider: "openai", model: "gpt-5.6-luna" },
          reasoning: "high",
        },
      },
      { type: "reuse", from: "model-selection.source:1" },
      {
        type: "branch",
        from: "model-selection.source:1",
        model: {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          reasoning: "low",
        },
      },
      {
        type: "branch",
        from: "model-selection.source:1",
        model: {
          model: { provider: "openai", model: "gpt-5.6-sol" },
          reasoning: "minimal",
        },
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("OpenCode");
    expect(JSON.stringify(plan)).not.toContain("function");
  });
});
