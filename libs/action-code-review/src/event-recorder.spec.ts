// @test-scope ./event-recorder.ts
// @test-scope ./publication.ts
import { describe, expect, it } from "vitest";
import { ExecutorError } from "@seqlane/core";
import { jsonValueSchema } from "@seqlane/core";
import { BoundedEventRecorder } from "./event-recorder.js";
import {
  derivePublicationMetrics,
  publicationSnapshotSchema,
} from "./publication.js";

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

  it("serializes retained Seqlane errors into JSON-safe events", () => {
    const recorder = new BoundedEventRecorder(4);
    recorder.emit({ type: "run.started", workId: "w", runId: "r" });
    recorder.emit({
      type: "invocation.retrying",
      workId: "w",
      runId: "r",
      invocationId: "i",
      attempt: 1,
      lastError: new ExecutorError("task-1", "retry me"),
    });
    recorder.emit({
      type: "invocation.failed",
      workId: "w",
      runId: "r",
      invocationId: "i",
      error: new ExecutorError("task-1", "failed"),
      disposition: "fail_run",
    });
    recorder.emit({
      type: "run.failed",
      workId: "w",
      runId: "r",
      error: new ExecutorError("task-1", "failed"),
    });

    const serialized = recorder.serializedEvents;
    expect(() => jsonValueSchema.parse(serialized)).not.toThrow();
    expect(serialized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invocation.retrying",
          lastError: expect.objectContaining({
            category: "ExecutorError",
            message: 'Task executor failed for "task-1": retry me',
            name: "ExecutorError",
            taskId: "task-1",
          }),
        }),
        expect.objectContaining({
          type: "invocation.failed",
          error: expect.objectContaining({
            category: "ExecutorError",
            name: "ExecutorError",
          }),
        }),
      ]),
    );

    const parsedSnapshot = publicationSnapshotSchema.safeParse({
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 3,
        verdict: "request-changes",
        summary: "failed",
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 3,
          rationale: "failed",
        })),
        findings: [],
        verification: [],
        headRevision: "b".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 1,
        limitations: [],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      },
      events: serialized,
      runId: "r",
    });
    expect(parsedSnapshot.success).toBe(true);
    if (parsedSnapshot.success) {
      expect(derivePublicationMetrics(parsedSnapshot.data).outcome).toBe(
        "failed",
      );
    }
  });
});
