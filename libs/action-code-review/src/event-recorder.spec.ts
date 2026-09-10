// @test-scope ./event-recorder.ts
// @test-scope ./publication.ts
import { describe, expect, it } from "vitest";
import { BoundedEventRecorder } from "./event-recorder.js";
import { deriveRunMetrics } from "./metrics.js";

describe("BoundedEventRecorder", () => {
  it("bounds during emission while retaining terminal and metric events", () => {
    const recorder = new BoundedEventRecorder(3);
    recorder.emit({ type: "run.started", workId: "w", runId: "r" });
    recorder.emit({
      type: "invocation.created",
      workId: "w",
      runId: "r",
      invocationId: "i",
      planNodeId: "p",
      subject: { type: "task", taskId: "t" },
      kind: "task",
      label: "task",
      siblingOrder: 0,
      dependencyIds: [],
    });
    recorder.emit({
      type: "invocation.output",
      workId: "w",
      runId: "r",
      invocationId: "i",
      policy: "persistent",
      channel: "task",
      content: "",
      metrics: { cost: 1 },
    });
    recorder.emit({
      type: "run.heartbeat",
      workId: "w",
      runId: "r",
      activeInvocationIds: [],
      elapsedMs: 1,
    });
    recorder.emit({
      type: "run.succeeded",
      workId: "w",
      runId: "r",
      output: null,
    });

    expect(recorder.truncated).toBe(true);
    expect(recorder.events).toHaveLength(3);
    expect(
      recorder.events.some((event) => event.type === "run.succeeded"),
    ).toBe(true);
    expect(
      recorder.events.some((event) => event.type === "invocation.output"),
    ).toBe(true);
  });

  it("retains metrics while excluding review payloads from publication events", () => {
    const recorder = new BoundedEventRecorder(4);
    recorder.emit({
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
    });
    recorder.emit({
      type: "invocation.output",
      workId: "w",
      runId: "r",
      invocationId: "i",
      policy: "persistent",
      channel: "task",
      content: "review output is not retained",
      metrics: {
        durationMs: 300,
        cost: 1,
        tokens: {
          input: 2,
          output: 3,
          reasoning: 4,
          cacheRead: 5,
          cacheWrite: 6,
        },
      },
    });
    recorder.emit({
      type: "invocation.activity",
      workId: "w",
      runId: "r",
      invocationId: "i",
      activityId: "a",
      kind: "tool",
      name: "review-tool",
      state: "succeeded",
      input: {
        state: "present",
        value: { comments: ["review input is not retained"] },
      },
    });
    recorder.emit({
      type: "invocation.succeeded",
      workId: "w",
      runId: "r",
      invocationId: "i",
    });
    recorder.emit({
      type: "run.succeeded",
      workId: "w",
      runId: "r",
      output: null,
    });

    expect(recorder.events).toEqual([
      {
        type: "invocation.created",
        workId: "w",
        runId: "r",
        invocationId: "i",
        taskId: "t",
        label: "Review",
      },
      {
        type: "invocation.output",
        workId: "w",
        runId: "r",
        invocationId: "i",
        metrics: expect.objectContaining({ durationMs: 300, cost: 1 }),
      },
      {
        type: "invocation.succeeded",
        workId: "w",
        runId: "r",
        invocationId: "i",
      },
      { type: "run.succeeded", workId: "w", runId: "r" },
    ]);
    expect(JSON.stringify(recorder.events)).not.toContain("review input");
    expect(JSON.stringify(recorder.events)).not.toContain("review output");
    expect(deriveRunMetrics(recorder.events, "r")).toMatchObject({
      outcome: "succeeded",
      totalCost: 1,
      totalTokens: { total: 20 },
      tasks: [{ task: "Review", durationMs: 300 }],
    });
  });
});
