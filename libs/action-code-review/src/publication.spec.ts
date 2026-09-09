// @test-scope ./publication.ts
import { describe, expect, it } from "vitest";
import { ExecutorError, ValidationFailedError } from "@seqlane/core";
import { derivePublication, publicationSnapshotSchema } from "./publication.js";

describe("model-free publication", () => {
  it("renders a bounded report from frozen data", () => {
    const result = derivePublication({ report: { verdict: "approve", summary: "No issues.", findings: [], headRevision: "a".repeat(40) }, runId: "run-1", events: [{ type: "run.started", workId: "work-1", runId: "run-1" }, { type: "run.succeeded", workId: "work-1", runId: "run-1", output: null }] });
    expect(result.publication.body).toContain("seqlane-code-review");
    expect(result.metrics.runId).toBe("run-1");
  });

  it("bounds long publication input and escapes table separators", () => {
    const result = derivePublication({
      report: {
        verdict: "request-changes",
        summary: "summary | with a pipe",
        findings: Array.from({ length: 40 }, (_, index) => ({
          id: `F-${index + 1}`,
          severity: "required" as const,
          summary: "x".repeat(2_000),
          recommendation: "y".repeat(2_000),
          axis: "security",
        })),
        headRevision: "a".repeat(40),
      },
      runId: "run-1",
      events: [],
    });
    expect(result.publication.body.length).toBeLessThanOrEqual(60_000);
    expect(result.publication.body).toContain("summary &#124; with a pipe");
  });

  it("rejects malformed or unbounded publication snapshots", () => {
    const base = {
      report: { repository: "owner/repository", baseBranch: "main", verdict: "approve", summary: "ok", findings: [], headRevision: "a".repeat(40) },
      events: [], runId: "run-1", completedAt: "2026-09-09T00:00:00.000Z",
    };
    expect(publicationSnapshotSchema.safeParse({ ...base, report: { ...base.report, extra: true } }).success).toBe(false);
    expect(publicationSnapshotSchema.safeParse({ ...base, events: [{ type: "run.started", workId: "w", runId: "r", extra: true }] }).success).toBe(false);
    expect(publicationSnapshotSchema.safeParse({ ...base, runId: "" }).success).toBe(false);
  });

  it("accepts every canonical in-memory Seqlane event variant", () => {
    const common = { workId: "work-1", runId: "run-1" };
    const subject = { type: "task" as const, taskId: "task-1" };
    const displayValue = { state: "present" as const, value: { ok: true } };
    const events = [
      { ...common, type: "run.started" as const },
      { ...common, type: "invocation.created" as const, invocationId: "i-1", planNodeId: "p-1", subject, taskId: "task-1", kind: "task" as const, label: "Task", siblingOrder: 0, dependencyIds: [] },
      { ...common, type: "invocation.progress" as const, invocationId: "i-1", state: "active" as const, phase: "execute" },
      { ...common, type: "invocation.output" as const, invocationId: "i-1", policy: "persistent" as const, channel: "task" as const, content: "done", metrics: { tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } },
      { ...common, type: "invocation.activity" as const, invocationId: "i-1", activityId: "a-1", kind: "tool" as const, name: "exec", state: "succeeded" as const, input: displayValue },
      { ...common, type: "invocation.input" as const, invocationId: "i-1", input: displayValue },
      { ...common, type: "invocation.result" as const, invocationId: "i-1", result: displayValue },
      { ...common, type: "invocation.retrying" as const, invocationId: "i-1", attempt: 1, lastError: new ExecutorError("task-1", "failed") },
      { ...common, type: "invocation.started" as const, invocationId: "i-1", subject },
      { ...common, type: "invocation.succeeded" as const, invocationId: "i-1" },
      { ...common, type: "invocation.failed" as const, invocationId: "i-1", error: new ValidationFailedError("p-1", "validator-1", [{ code: "invalid", message: "bad", path: "/ok" }], { ok: false }), disposition: "fail_run" as const },
      { ...common, type: "invocation.skipped" as const, invocationId: "i-1", reason: "dependency failed" },
      { ...common, type: "invocation.cancelled" as const, invocationId: "i-1", reason: "cancelled" },
      { ...common, type: "run.heartbeat" as const, activeInvocationIds: ["i-1"], elapsedMs: 1 },
      { ...common, type: "run.succeeded" as const, output: { ok: true } },
      { ...common, type: "run.failed" as const, error: new ExecutorError("task-1", "failed") },
      { ...common, type: "run.cancelled" as const },
    ];
    const result = publicationSnapshotSchema.safeParse({
      report: { verdict: "approve", summary: "ok", findings: [], headRevision: "a".repeat(40) },
      events,
      runId: "run-1",
      completedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});
