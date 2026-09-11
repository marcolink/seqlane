// @test-scope ./metrics.ts
import { describe, expect, it } from "vitest";
import { deriveRunMetrics, reviewRunMetricsSchema } from "./metrics.js";

describe("review metrics", () => {
  it("retains deduplicated skill usage per task", () => {
    const metrics = deriveRunMetrics(
      [
        {
          type: "invocation.created",
          workId: "w",
          runId: "r",
          invocationId: "i",
          planNodeId: "p",
          subject: { type: "task", taskId: "t" },
          kind: "task",
          label: "Review",
          siblingOrder: 0,
          dependencyIds: [],
          taskId: "t",
        },
        {
          type: "invocation.activity",
          workId: "w",
          runId: "r",
          invocationId: "i",
          activityId: "skill-1",
          kind: "skill",
          name: "web-perf",
          state: "started",
        },
        {
          type: "invocation.activity",
          workId: "w",
          runId: "r",
          invocationId: "i",
          activityId: "skill-1",
          kind: "skill",
          name: "web-perf",
          state: "succeeded",
        },
        {
          type: "invocation.activity",
          workId: "w",
          runId: "r",
          invocationId: "i",
          activityId: "skill-2",
          kind: "skill",
          name: "security",
          state: "succeeded",
        },
        {
          type: "invocation.succeeded",
          workId: "w",
          runId: "r",
          invocationId: "i",
        },
        { type: "run.succeeded", workId: "w", runId: "r", output: null },
      ],
      "r",
    );

    expect(metrics.tasks[0]?.skills).toEqual([
      { name: "security", count: 1 },
      { name: "web-perf", count: 1 },
    ]);
    expect(reviewRunMetricsSchema.safeParse(metrics).success).toBe(true);
  });

  it("derives totals without model calls", () => {
    const metrics = deriveRunMetrics(
      [
        { type: "run.started", workId: "w", runId: "r" },
        {
          type: "invocation.output",
          workId: "w",
          runId: "r",
          invocationId: "i",
          policy: "persistent",
          channel: "task",
          content: "",
          metrics: {
            cost: 1,
            tokens: {
              input: 2,
              output: 3,
              reasoning: 4,
              cacheRead: 5,
              cacheWrite: 6,
            },
          },
        },
        { type: "run.succeeded", workId: "w", runId: "r", output: null },
      ],
      "r",
    );
    expect(metrics.outcome).toBe("succeeded");
    expect(metrics.totalCost).toBe(1);
    expect(metrics.totalTokens.total).toBe(20);
  });

  it("does not infer a selected model from measured usage", () => {
    const metrics = deriveRunMetrics(
      [
        { type: "run.started", workId: "w", runId: "r" },
        {
          type: "invocation.created",
          workId: "w",
          runId: "r",
          invocationId: "i",
          planNodeId: "p",
          subject: { type: "task", taskId: "t" },
          kind: "task",
          label: "Review",
          siblingOrder: 0,
          dependencyIds: [],
          taskId: "t",
        },
        {
          type: "invocation.output",
          workId: "w",
          runId: "r",
          invocationId: "i",
          policy: "persistent",
          channel: "task",
          content: "",
          metrics: {
            durationMs: 300,
            modelSelection: {
              model: { provider: "openai", model: "gpt-5.6-luna" },
            },
          },
        },
        {
          type: "invocation.succeeded",
          workId: "w",
          runId: "r",
          invocationId: "i",
        },
        { type: "run.succeeded", workId: "w", runId: "r", output: null },
      ],
      "r",
    );
    expect(metrics.tasks).toHaveLength(1);
    expect(metrics.tasks[0]).toMatchObject({ durationMs: 300 });
    expect(metrics.tasks[0]).not.toHaveProperty("model");
    expect(metrics.tasks[0]).not.toHaveProperty("provider");
  });

  it("uses only the latest output for task and run totals", () => {
    const metrics = deriveRunMetrics(
      [
        {
          type: "invocation.created",
          workId: "w",
          runId: "r",
          invocationId: "i",
          planNodeId: "p",
          subject: { type: "task", taskId: "t" },
          kind: "task",
          label: "Review",
          siblingOrder: 0,
          dependencyIds: [],
          taskId: "t",
        },
        {
          type: "invocation.output",
          workId: "w",
          runId: "r",
          invocationId: "i",
          policy: "persistent",
          channel: "task",
          content: "first",
          metrics: {
            durationMs: 10,
            cost: 1,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
        {
          type: "invocation.output",
          workId: "w",
          runId: "r",
          invocationId: "i",
          policy: "persistent",
          channel: "task",
          content: "last",
          metrics: {
            durationMs: 20,
            cost: 2,
            tokens: {
              input: 2,
              output: 2,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
        {
          type: "invocation.succeeded",
          workId: "w",
          runId: "r",
          invocationId: "i",
        },
        { type: "run.succeeded", workId: "w", runId: "r", output: null },
      ],
      "r",
    );
    expect(metrics.tasks).toMatchObject([{ durationMs: 20, cost: 2 }]);
    expect(metrics.totalCost).toBe(2);
    expect(metrics.totalTokens.total).toBe(4);
  });

  it("derives run duration from the latest heartbeat", () => {
    const metrics = deriveRunMetrics(
      [
        {
          type: "run.heartbeat",
          workId: "w",
          runId: "r",
          activeInvocationIds: ["i"],
          elapsedMs: 1250,
        },
        {
          type: "run.heartbeat",
          workId: "w",
          runId: "r",
          activeInvocationIds: [],
          elapsedMs: 2500,
        },
        { type: "run.succeeded", workId: "w", runId: "r", output: null },
      ],
      "r",
    );
    expect(metrics.durationMs).toBe(2500);
  });

  it("falls back to the latest task duration without heartbeats", () => {
    const metrics = deriveRunMetrics(
      [
        {
          type: "invocation.created",
          workId: "w",
          runId: "r",
          invocationId: "i",
          planNodeId: "p",
          subject: { type: "task", taskId: "t" },
          kind: "task",
          label: "Review",
          siblingOrder: 0,
          dependencyIds: [],
        },
        {
          type: "invocation.output",
          workId: "w",
          runId: "r",
          invocationId: "i",
          policy: "persistent",
          channel: "task",
          content: "done",
          metrics: { durationMs: 700 },
        },
        {
          type: "invocation.succeeded",
          workId: "w",
          runId: "r",
          invocationId: "i",
        },
        { type: "run.succeeded", workId: "w", runId: "r", output: null },
      ],
      "r",
    );
    expect(metrics.durationMs).toBe(700);
  });
});
