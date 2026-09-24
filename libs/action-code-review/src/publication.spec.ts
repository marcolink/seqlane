// @test-scope ./publication.ts
import { describe, expect, it } from "vitest";
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
        {
          type: "invocation.output",
          workId: "work-1",
          runId: "run-1",
          invocationId: "task-1",
          metrics: {
            durationMs: 1,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 2,
            },
          },
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
          status: "open" as const,
          summary: "x".repeat(2_000),
          recommendation: "y".repeat(2_000),
          axis: "security",
          aliases: [],
        })),
        verification: [],
        headRevision: "a".repeat(40),
        previousReviewedRevision: "b".repeat(40),
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
    expect(result.publication.body).toContain("🟠 Required");
    expect(result.publication.body).toContain("⏳ Open");
    expect(result.publication.body).toContain("🔐 Security");
    expect(result.publication.body).toContain(
      "> **Review delta:** 🆕 0 new · ⏳ 40 open",
    );
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
      "<!-- seqlane-code-review-meta-v4:",
    );
    expect(result.publication.body).toContain(
      "<!-- seqlane-code-review-run-metrics-v1-start -->",
    );
    expect(result.publication.body).toContain(
      "<!-- seqlane-code-review-state-v4-start -->",
    );
    expect(result.publication.body).toContain(
      "<!-- seqlane-code-review-state-v4-end -->",
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

  it("links the visible report header to the GitHub Actions run", () => {
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
        headRevision: "a".repeat(40),
        pullRequestNumber: 1,
        nextFindingIndex: 1,
        limitations: [],
        stateTruncated: false,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      },
      runId: "run-1",
      githubRunId: "123",
      events: [],
    });
    expect(result.publication.body).toContain(
      "[View GitHub Actions run](https://github.com/owner/repository/actions/runs/123)",
    );
  });

  it("omits a report run link for malformed repository or run id", () => {
    const baseReport = {
      repository: "owner/repository",
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      overallRating: 5,
      verdict: "approve" as const,
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
      runMetricsLedger: { schemaVersion: 1 as const, runs: [] },
    };
    for (const snapshot of [
      { report: baseReport, runId: "run-1", githubRunId: "0", events: [] },
      {
        report: { ...baseReport, repository: "owner/evil repo" },
        runId: "run-1",
        githubRunId: "123",
        events: [],
      },
    ]) {
      expect(derivePublication(snapshot).publication.body).not.toContain(
        "https://github.com/",
      );
    }
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

  it("accepts the Action-private metric event projection", () => {
    const common = { workId: "work-1", runId: "run-1" };
    const events = [
      {
        ...common,
        type: "invocation.created" as const,
        invocationId: "i-1",
        taskId: "task-1",
        label: "Task",
      },
      {
        ...common,
        type: "invocation.output" as const,
        invocationId: "i-1",
        metrics: { durationMs: 10 },
      },
      { ...common, type: "invocation.succeeded" as const, invocationId: "i-1" },
      { ...common, type: "run.heartbeat" as const, elapsedMs: 1 },
      { ...common, type: "run.succeeded" as const },
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
    expect(
      publicationSnapshotSchema.safeParse({
        report: result.success ? result.data.report : undefined,
        events: [
          { ...common, type: "invocation.activity", invocationId: "i-1" },
        ],
        runId: "run-1",
      }).success,
    ).toBe(false);
  });
});
