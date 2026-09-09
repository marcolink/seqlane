// @test-scope ./publication.ts
import { describe, expect, it } from "vitest";
import { ExecutorError, ValidationFailedError } from "@seqlane/core";
import { derivePublication, publicationSnapshotSchema } from "./publication.js";

describe("model-free publication", () => {
  it("renders a bounded report from frozen data", () => {
    const result = derivePublication({
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 5,
        verdict: "approve",
        summary: "No issues.",
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 5,
          rationale: "ok",
        })),
        findings: [],
        verification: [],
        headRevision: "a".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 1,
        limitations: [],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      },
      runId: "run-1",
      events: [
        { type: "run.started", workId: "work-1", runId: "run-1" },
        {
          type: "run.succeeded",
          workId: "work-1",
          runId: "run-1",
          output: null,
        },
      ],
    });
    expect(result.publication.body).toContain("seqlane-code-review");
    expect(result.metrics.runId).toBe("run-1");
  });

  it("bounds long publication input and escapes table separators", () => {
    const result = derivePublication({
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 3,
        verdict: "request-changes",
        summary: "summary | with a pipe",
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 3,
          rationale: "ok",
        })),
        findings: Array.from({ length: 40 }, (_, index) => ({
          id: `F-${index + 1}`,
          severity: "required" as const,
          effectiveSeverity: "required" as const,
          disposition: "open" as const,
          status: "open" as const,
          summary: "x".repeat(2_000),
          recommendation: "y".repeat(2_000),
          axis: "security",
          aliases: [],
        })),
        verification: [],
        headRevision: "a".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 41,
        limitations: [],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      },
      runId: "run-1",
      events: [],
    });
    expect(result.publication.body.length).toBeLessThanOrEqual(60_000);
    expect(result.publication.body).toContain("summary &#124; with a pipe");
  });

  it("neutralizes model-controlled Markdown links, images, and external URLs", () => {
    const malicious =
      "[click](https://evil.example) ![image](https://evil.example/a.png) www.evil.example";
    const result = derivePublication({
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 3,
        verdict: "request-changes",
        summary: malicious,
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 3,
          rationale: malicious,
        })),
        findings: [
          {
            id: "F-1",
            severity: "required",
            effectiveSeverity: "required",
            disposition: "open",
            status: "open",
            summary: malicious,
            recommendation: malicious,
            axis: "security",
            aliases: [],
          },
        ],
        verification: [malicious],
        headRevision: "b".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 2,
        limitations: [malicious],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      },
      runId: "run-1",
      events: [],
    });

    expect(result.publication.body).not.toContain("https://evil.example");
    expect(result.publication.body).not.toContain("www.evil.example");
    expect(result.publication.body).not.toContain("[click](");
    expect(result.publication.body).not.toContain("![image](");
  });

  it("keeps required markers and stays within the UTF-8 byte limit", () => {
    const result = derivePublication({
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 5,
        verdict: "approve",
        summary: "😀".repeat(6_000),
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 5,
          rationale: "ok",
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
      runId: "run-1",
      events: [],
    });
    expect(
      new TextEncoder().encode(result.publication.body).length,
    ).toBeLessThanOrEqual(60_000);
    expect(result.publication.body).toContain(
      "<!-- seqlane-code-review-meta-v3:",
    );
    expect(result.publication.body).toContain(
      "<!-- seqlane-code-review-run-metrics-v1-start -->",
    );
    expect(result.publication.body).toContain(
      "<!-- seqlane-code-review-state-v3-start -->",
    );
    expect(result.publication.body).toContain(
      "<!-- seqlane-code-review-state-v3-end -->",
    );
  });

  it("retains only the latest forty metric runs and records the omission", () => {
    const runs = Array.from({ length: 40 }, (_, index) => ({
      githubRunId: String(index + 1),
      attempt: 1,
      completedAt: `2026-09-09T00:${String(index).padStart(2, "0")}:00.000Z`,
      reviewedRevision: "a".repeat(40),
      metrics: {
        schemaVersion: 1 as const,
        runId: `run-${index + 1}`,
        outcome: "succeeded" as const,
        durationMs: 0,
        totalCost: 0,
        totalTokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        tasks: [],
      },
    }));
    const result = derivePublication({
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 5,
        verdict: "approve",
        summary: "ok",
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 5,
          rationale: "ok",
        })),
        findings: [],
        verification: [],
        headRevision: "b".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 1,
        limitations: [],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs },
      },
      runId: "run-41",
      githubRunId: "41",
      attempt: 1,
      events: [],
    });
    expect(result.publication.body).toContain('"githubRunId": "41"');
    expect(result.publication.body).not.toContain('"githubRunId": "1"');
    expect(result.publication.body).toContain("metrics ledger was bounded");
  });

  it("rejects malformed or unbounded publication snapshots", () => {
    const base = {
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 5,
        verdict: "approve",
        summary: "ok",
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 5,
          rationale: "ok",
        })),
        findings: [],
        verification: [],
        headRevision: "a".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 1,
        limitations: [],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      },
      events: [],
      runId: "run-1",
      completedAt: "2026-09-09T00:00:00.000Z",
    };
    expect(
      publicationSnapshotSchema.safeParse({
        ...base,
        report: { ...base.report, extra: true },
      }).success,
    ).toBe(false);
    expect(
      publicationSnapshotSchema.safeParse({
        ...base,
        events: [{ type: "run.started", workId: "w", runId: "r", extra: true }],
      }).success,
    ).toBe(false);
    expect(
      publicationSnapshotSchema.safeParse({ ...base, runId: "" }).success,
    ).toBe(false);
  });

  it("accepts every canonical in-memory Seqlane event variant", () => {
    const common = { workId: "work-1", runId: "run-1" };
    const subject = { type: "task" as const, taskId: "task-1" };
    const displayValue = { state: "present" as const, value: { ok: true } };
    const events = [
      { ...common, type: "run.started" as const },
      {
        ...common,
        type: "invocation.created" as const,
        invocationId: "i-1",
        planNodeId: "p-1",
        subject,
        taskId: "task-1",
        kind: "task" as const,
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
      },
      {
        ...common,
        type: "invocation.progress" as const,
        invocationId: "i-1",
        state: "active" as const,
        phase: "execute",
      },
      {
        ...common,
        type: "invocation.output" as const,
        invocationId: "i-1",
        policy: "persistent" as const,
        channel: "task" as const,
        content: "done",
        metrics: {
          tokens: {
            input: 1,
            output: 2,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
      {
        ...common,
        type: "invocation.activity" as const,
        invocationId: "i-1",
        activityId: "a-1",
        kind: "tool" as const,
        name: "exec",
        state: "succeeded" as const,
        input: displayValue,
      },
      {
        ...common,
        type: "invocation.input" as const,
        invocationId: "i-1",
        input: displayValue,
      },
      {
        ...common,
        type: "invocation.result" as const,
        invocationId: "i-1",
        result: displayValue,
      },
      {
        ...common,
        type: "invocation.retrying" as const,
        invocationId: "i-1",
        attempt: 1,
        lastError: new ExecutorError("task-1", "failed"),
      },
      {
        ...common,
        type: "invocation.started" as const,
        invocationId: "i-1",
        subject,
      },
      { ...common, type: "invocation.succeeded" as const, invocationId: "i-1" },
      {
        ...common,
        type: "invocation.failed" as const,
        invocationId: "i-1",
        error: new ValidationFailedError(
          "p-1",
          "validator-1",
          [{ code: "invalid", message: "bad", path: "/ok" }],
          { ok: false },
        ),
        disposition: "fail_run" as const,
      },
      {
        ...common,
        type: "invocation.skipped" as const,
        invocationId: "i-1",
        reason: "dependency failed",
      },
      {
        ...common,
        type: "invocation.cancelled" as const,
        invocationId: "i-1",
        reason: "cancelled",
      },
      {
        ...common,
        type: "run.heartbeat" as const,
        activeInvocationIds: ["i-1"],
        elapsedMs: 1,
      },
      { ...common, type: "run.succeeded" as const, output: { ok: true } },
      {
        ...common,
        type: "run.failed" as const,
        error: new ExecutorError("task-1", "failed"),
      },
      { ...common, type: "run.cancelled" as const },
    ];
    const result = publicationSnapshotSchema.safeParse({
      report: {
        repository: "owner/repository",
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        overallRating: 5,
        verdict: "approve",
        summary: "ok",
        ratings: [
          "correctness",
          "readability",
          "architecture",
          "security",
          "performance",
        ].map((axis) => ({
          axis: axis as "correctness",
          rating: 5,
          rationale: "ok",
        })),
        findings: [],
        verification: [],
        headRevision: "a".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 1,
        limitations: [],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      },
      events,
      runId: "run-1",
      completedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});
