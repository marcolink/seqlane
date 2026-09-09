// @test-scope ./review-progress.ts

import { describe, expect, it } from "vitest";
import {
  createReviewProgress,
  formatReviewProgressEvent,
  type ReviewProgressEvent,
} from "./review-progress.js";

describe("code review progress", () => {
  it("formats safe lifecycle lines with task metrics", () => {
    expect(
      formatReviewProgressEvent({
        kind: "review-started",
        headRevision: "abcdef1234567890",
      }),
    ).toBe("Seqlane review started: head=abcdef1.");
    expect(
      formatReviewProgressEvent({
        kind: "task-started",
        label: "correctness",
        taskId: "review-correctness",
      }),
    ).toBe("Task started: correctness (review-correctness).");
    expect(
      formatReviewProgressEvent({
        kind: "task-completed",
        label: "correctness",
        taskId: "review-correctness",
        status: "succeeded",
        metrics: { durationMs: 37_000, cost: 0.0084, totalTokens: 170_277 },
      }),
    ).toBe(
      "Task completed: correctness (review-correctness) — status=succeeded; duration=37.0s; cost=$0.0084; tokens=170,277.",
    );
    expect(
      formatReviewProgressEvent({
        kind: "review-completed",
        status: "succeeded",
        elapsedMs: 139_000,
      }),
    ).toBe("Seqlane review completed: status=succeeded — 2m 19s elapsed.");
  });

  it("sanitizes untrusted identifiers and never includes raw event text", () => {
    const event: ReviewProgressEvent = {
      kind: "task-completed",
      label: "bad\nlabel\u001bsecret-content",
      taskId: "id\r\nwith spaces",
      status: "failed",
      metrics: {
        durationMs: -1,
        cost: Number.NaN,
        totalTokens: Number.POSITIVE_INFINITY,
      },
    };

    const line = formatReviewProgressEvent(event);
    expect(line).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
    expect(line).not.toContain("secret-content");
    expect(line).toContain("status=failed");
    expect(line.length).toBeLessThanOrEqual(240);
  });

  it("emits lifecycle events from Seqlane events and reports elapsed time", () => {
    const events: ReviewProgressEvent[] = [];
    let now = 1_000;
    const progress = createReviewProgress(
      { write: (event) => events.push(event) },
      { headRevision: "abcdef1234567890", now: () => now },
    );

    progress.emit({ type: "run.started", workId: "work", runId: "run" });
    progress.emit({
      type: "invocation.created",
      workId: "work",
      runId: "run",
      invocationId: "invocation",
      planNodeId: "node",
      subject: { type: "task", taskId: "task" },
      taskId: "task",
      kind: "task",
      label: "correctness",
      siblingOrder: 0,
      dependencyIds: [],
    });
    progress.emit({
      type: "invocation.started",
      workId: "work",
      runId: "run",
      invocationId: "invocation",
      subject: { type: "task", taskId: "task" },
      taskId: "task",
    });
    progress.emit({
      type: "invocation.succeeded",
      workId: "work",
      runId: "run",
      invocationId: "invocation",
    });
    progress.emit({
      type: "invocation.output",
      workId: "work",
      runId: "run",
      invocationId: "invocation",
      policy: "transient",
      channel: "task",
      content: "must never be logged",
      metrics: {
        durationMs: 2_000,
        cost: 0.01,
        tokens: {
          input: 1,
          output: 2,
          reasoning: 3,
          cacheRead: 4,
          cacheWrite: 5,
          total: 15,
        },
      },
    });
    now = 4_000;
    progress.emit({
      type: "run.succeeded",
      workId: "work",
      runId: "run",
      output: {},
    });

    expect(events).toEqual([
      { kind: "review-started", headRevision: "abcdef1234567890" },
      { kind: "task-started", label: "correctness", taskId: "task" },
      {
        kind: "task-completed",
        label: "correctness",
        taskId: "task",
        status: "succeeded",
        metrics: { durationMs: 2_000, cost: 0.01, totalTokens: 15 },
      },
      { kind: "review-completed", status: "succeeded", elapsedMs: 3_000 },
    ]);
  });

  it("does not let a logging failure change the review outcome", () => {
    const progress = createReviewProgress(
      {
        write: () => {
          throw new Error("logging failed");
        },
      },
      { headRevision: "abcdef1234567890", now: () => 1_000 },
    );

    expect(() =>
      progress.emit({ type: "run.started", workId: "work", runId: "run" }),
    ).not.toThrow();
    expect(() => progress.complete("succeeded")).not.toThrow();
  });
});
