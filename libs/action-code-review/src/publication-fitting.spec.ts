// @test-scope ./publication.ts
// @test-scope ./publication-rendering.ts
import { gunzipSync } from "node:zlib";
import {
  reviewStateEnvelopeSchema,
  reviewStateSchema,
} from "@seqlane/code-review-workflow/contracts";
import { describe, expect, it } from "vitest";
import {
  ledgerSchema,
  reportSchema,
  type PublicationLedger,
  type PublicationReport,
} from "./publication-contracts.js";
import { fitPublicationBody } from "./publication-fitting.js";
import { renderPublicationBody } from "./publication-rendering.js";
import { publicationSnapshotSchema, renderPublication } from "./publication.js";

function reviewReport(runCount: number, taskCount: number): PublicationReport {
  return reportSchema.parse({
    repository: "owner/repository",
    baseBranch: "main",
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    pullRequestNumber: 1,
    nextFindingIndex: 20,
    overallRating: 3,
    verdict: "request-changes",
    summary: "Required findings remain open.",
    ratings: [
      "correctness",
      "readability",
      "architecture",
      "security",
      "performance",
    ].map((axis) => ({ axis, rating: 3, rationale: "Static inspection." })),
    findings: Array.from({ length: 19 }, (_, index) => ({
      id: `SEQ-PR1-${String(index + 1).padStart(3, "0")}`,
      severity: "required",
      status: "open",
      axis: "correctness",
      summary: "Observed correctness problem. ".repeat(11),
      recommendation: "Correct the behavior and add a regression. ".repeat(8),
      aliases: [],
    })),
    verification: ["Static inspection only."],
    limitations: [],
    stateTruncated: false,
    runMetricsLedger: {
      schemaVersion: 1,
      runs: Array.from({ length: runCount }, (_, index) => ({
        githubRunId: String(index + 1),
        attempt: 1,
        completedAt: "2026-10-05T18:34:03.000Z",
        reviewedRevision: "b".repeat(40),
        metrics: {
          schemaVersion: 1,
          runId: `run-${index + 1}`,
          outcome: "succeeded",
          durationMs: 30_000,
          totalCost: 0.028949,
          totalTokens: {
            input: 15,
            output: 2201,
            reasoning: 7712,
            cacheRead: 159532,
            cacheWrite: 66334,
            total: 235794,
          },
          tasks: Array.from({ length: taskCount }, (_, taskIndex) => ({
            invocationId: `39f2e93f-51f7-4a61-a4d9-${String(taskIndex).padStart(12, "0")}`,
            task: "code-review-correctness",
            taskId: "code-review-correctness",
            resultState: "succeeded",
            durationMs: 30_000,
            model: "gpt-6-luna",
            provider: "openai",
            cost: 0.00620795,
            tokens: {
              input: 3,
              output: 340,
              reasoning: 2463,
              cacheRead: 81681,
              cacheWrite: 7276,
              total: 91763,
            },
            skills: [{ name: "mastra", count: 1 }],
          })),
        },
      })),
    },
  });
}

function visibleLedger(body: string): PublicationLedger {
  const json = body.match(
    /<!-- seqlane-code-review-run-metrics-v1-start -->\s*```json\s*([\s\S]*?)\s*```/,
  )?.[1];
  if (json === undefined) throw new Error("Published metrics ledger missing.");
  return ledgerSchema.parse(JSON.parse(json));
}

describe("publication fitting", () => {
  it("keeps findings and complete task metrics visible as review history grows", () => {
    const report = reviewReport(11, 8);
    const ledger = report.runMetricsLedger;
    const unfitted = renderPublicationBody(
      report,
      { visibleFindings: 20, includeVerification: true },
      ledger,
      "11",
      1,
    );
    expect(Buffer.byteLength(unfitted)).toBeGreaterThan(60_000);

    const result = fitPublicationBody(report, ledger, "11", 1);

    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(60_000);
    for (const finding of report.findings) {
      expect(result.body).toContain(`| \`${finding.id}\` |`);
    }
    expect(result.body).not.toContain("✅ No findings.");
    expect(result.body).not.toContain("Showing 0 of");
    expect(visibleLedger(result.body)).toEqual(ledger);
    expect(result.report.findings).toEqual(report.findings);
    expect(result.report.verification).toEqual(report.verification);
  });

  it("compacts task details before hiding findings while preserving run totals", () => {
    const report = reviewReport(40, 40);
    const result = fitPublicationBody(report, report.runMetricsLedger, "40", 1);

    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(60_000);
    for (const finding of report.findings) {
      expect(result.body).toContain(`| \`${finding.id}\` |`);
    }
    expect(result.body).toContain(
      "Detailed task metrics were compacted to fit the publication limit.",
    );
    expect(visibleLedger(result.body).runs).toEqual(
      report.runMetricsLedger.runs.map((run) => ({
        ...run,
        metrics: { ...run.metrics, tasks: [] },
      })),
    );
    expect(result.report.findings).toHaveLength(19);
    expect(result.report.stateTruncated).toBe(true);
    expect(result.report.limitations).toContain(
      "Review text was compacted to fit the publication limit.",
    );
  });

  it("publishes complete UTF-8 findings and metrics through the public publication path", () => {
    const report = reviewReport(11, 8);
    const firstFinding = report.findings[0];
    if (firstFinding === undefined) throw new Error("Review finding missing.");
    firstFinding.summary = "😀".repeat(300);
    const latest = report.runMetricsLedger.runs.at(-1);
    if (latest === undefined) throw new Error("Review metrics missing.");
    const snapshot = publicationSnapshotSchema.parse({
      report,
      events: [],
      runId: latest.metrics.runId,
      githubRunId: latest.githubRunId,
      attempt: latest.attempt,
      completedAt: latest.completedAt,
    });

    const publication = renderPublication(snapshot, latest.metrics);

    expect(Buffer.byteLength(publication.body)).toBeLessThanOrEqual(60_000);
    expect(publication.body).toContain(firstFinding.summary);
    for (const finding of report.findings) {
      expect(publication.body).toContain(`| \`${finding.id}\` |`);
    }
    expect(visibleLedger(publication.body)).toEqual(report.runMetricsLedger);
    const stateJson = publication.body.match(
      /<!-- seqlane-code-review-state-v4-start -->\s*```json\s*([\s\S]*?)\s*```/,
    )?.[1];
    if (stateJson === undefined) throw new Error("Review state missing.");
    const envelope = reviewStateEnvelopeSchema.parse(JSON.parse(stateJson));
    const state = reviewStateSchema.parse(
      JSON.parse(
        gunzipSync(Buffer.from(envelope.data, "base64"), {
          maxOutputLength: 1_000_000,
        }).toString("utf8"),
      ),
    );
    expect(state.findings).toEqual(report.findings);
    expect(state.truncated).toBe(false);
  });

  it("distinguishes omitted findings from an empty review", () => {
    const report = reviewReport(0, 0);
    const options = { visibleFindings: 0, includeVerification: false };
    const omitted = renderPublicationBody(
      report,
      options,
      report.runMetricsLedger,
      "1",
      1,
    );
    expect(omitted).not.toContain("✅ No findings.");
    expect(omitted).toContain("Showing 0 of 19 retained findings.");

    const empty = renderPublicationBody(
      { ...report, findings: [] },
      options,
      report.runMetricsLedger,
      "1",
      1,
    );
    expect(empty).toContain("✅ No findings.");
  });

  it("reduces rows gradually and keeps active blockers before resolved history", () => {
    const report = reviewReport(40, 40);
    report.limitations = Array.from({ length: 10 }, () => "<".repeat(800));
    report.findings = report.findings.map((finding, index) => ({
      ...finding,
      status: index === 18 ? "open" : "resolved",
    }));

    const result = fitPublicationBody(report, report.runMetricsLedger, "40", 1);
    const rows = result.body.match(/^\| `SEQ-PR1-\d{3}` \|/gm) ?? [];

    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(60_000);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(19);
    expect(rows[0]).toBe("| `SEQ-PR1-019` |");
    expect(result.body).toContain(
      `Showing ${rows.length} of 19 retained findings.`,
    );
    expect(result.report.findings).toHaveLength(19);
  });

  it("rejects an oversized report instead of publishing zero retained findings", () => {
    const report = reviewReport(40, 40);
    report.limitations = Array.from({ length: 20 }, () => "&".repeat(800));

    expect(() =>
      fitPublicationBody(report, report.runMetricsLedger, "40", 1),
    ).toThrow("too large to publish safely");
  });
});
