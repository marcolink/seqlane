// @test-scope ./metrics.ts
import { describe, expect, it } from "vitest";
import { deriveRunMetrics } from "./metrics.js";

describe("review metrics", () => {
  it("derives totals without model calls", () => {
    const metrics = deriveRunMetrics([
      { type: "run.started", workId: "w", runId: "r" },
      { type: "invocation.output", workId: "w", runId: "r", invocationId: "i", policy: "persistent", channel: "task", content: "", metrics: { cost: 1, tokens: { input: 2, output: 3, reasoning: 4, cacheRead: 5, cacheWrite: 6 } } },
      { type: "run.succeeded", workId: "w", runId: "r", output: null },
    ], "r");
    expect(metrics.outcome).toBe("succeeded");
    expect(metrics.totalCost).toBe(1);
    expect(metrics.totalTokens.total).toBe(20);
  });

  it("does not infer a selected model from measured usage", () => {
    const metrics = deriveRunMetrics([
      { type: "run.started", workId: "w", runId: "r" },
      { type: "invocation.created", workId: "w", runId: "r", invocationId: "i", planNodeId: "p", subject: { type: "task", taskId: "t" }, kind: "task", label: "Review", siblingOrder: 0, dependencyIds: [], taskId: "t" },
      { type: "invocation.output", workId: "w", runId: "r", invocationId: "i", policy: "persistent", channel: "task", content: "", metrics: { durationMs: 300, modelSelection: { model: { provider: "openai", model: "gpt-5.6-luna" } } } },
      { type: "invocation.succeeded", workId: "w", runId: "r", invocationId: "i", taskId: "t", subject: { type: "task", taskId: "t" } },
      { type: "run.succeeded", workId: "w", runId: "r", output: null },
    ], "r");
    expect(metrics.tasks).toHaveLength(1);
    expect(metrics.tasks[0]).toMatchObject({ durationMs: 300 });
    expect(metrics.tasks[0]).not.toHaveProperty("model");
    expect(metrics.tasks[0]).not.toHaveProperty("provider");
  });
});
