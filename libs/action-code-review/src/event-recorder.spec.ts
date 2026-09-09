// @test-scope ./event-recorder.ts
import { describe, expect, it } from "vitest";
import { BoundedEventRecorder } from "./event-recorder.js";

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
});
