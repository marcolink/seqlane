import { gzipSync } from "node:zlib";
import { z } from "zod";
import {
  type PublicationLedger,
  type PublicationReport,
  type PublicationSnapshot,
  EMPTY_LEDGER,
  ledgerSchema,
  reportSchema,
} from "./publication-contracts.js";
import type { ReviewRunMetrics } from "./metrics.js";

function parseLedger(value: unknown): z.infer<typeof ledgerSchema> {
  const parsed = ledgerSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_LEDGER;
}
function encodeState(report: z.infer<typeof reportSchema>): string {
  return gzipSync(
    JSON.stringify({
      schemaVersion: 3,
      pullRequestNumber: report.pullRequestNumber ?? 1,
      baseRevision: report.baseRevision ?? report.headRevision,
      reviewedRevision: report.headRevision,
      ...(report.previousReviewedRevision === undefined
        ? {}
        : { previousReviewedRevision: report.previousReviewedRevision }),
      nextFindingIndex: report.nextFindingIndex,
      findings: report.findings,
      limitations: report.limitations,
      truncated: report.stateTruncated,
    }),
  ).toString("base64");
}

const MAX_STATE_PAYLOAD_CHARS = 20_000;
export const MAX_PUBLICATION_BODY_CHARS = 60_000;
const STATE_COMPACTION_NOTICE =
  "The machine-readable review state was compacted to fit the publication limit.";
const METRICS_LEDGER_TRUNCATION_NOTICE =
  "The run metrics ledger was bounded to the latest 40 runs.";
const EVENT_TRUNCATION_NOTICE =
  "The execution event stream was bounded; some non-terminal events were omitted.";
export const MAX_PUBLICATION_BODY_BYTES = 60_000;

function shorten(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

function shortenUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  const suffix = new TextEncoder().encode("…");
  const bounded = bytes.subarray(0, Math.max(0, maxBytes - suffix.length));
  return new TextDecoder().decode(bounded) + "…";
}

function stateReport(
  report: z.infer<typeof reportSchema>,
): z.infer<typeof reportSchema> {
  let candidate = report;
  let payload = encodeState(candidate);
  if (payload.length <= MAX_STATE_PAYLOAD_CHARS) return candidate;

  candidate = {
    ...candidate,
    findings: candidate.findings.map((finding) => ({
      ...finding,
      summary: shorten(finding.summary, 320),
      recommendation: shorten(finding.recommendation, 320),
      ...(finding.file === undefined
        ? {}
        : { file: shorten(finding.file, 256) }),
    })),
    limitations: [
      ...candidate.limitations
        .filter((value) => value !== STATE_COMPACTION_NOTICE)
        .slice(0, 19),
      STATE_COMPACTION_NOTICE,
    ],
    stateTruncated: true,
  };
  payload = encodeState(candidate);
  if (payload.length <= MAX_STATE_PAYLOAD_CHARS) return candidate;

  candidate = {
    ...candidate,
    findings: candidate.findings.map((finding) => ({
      ...finding,
      summary: "Historical finding retained in compact state.",
      recommendation: "Re-evaluate this finding against the current head.",
      file: undefined,
      line: undefined,
      dispositionReason: undefined,
    })),
    limitations: [
      ...candidate.limitations
        .filter((value) => value !== STATE_COMPACTION_NOTICE)
        .slice(0, 19),
      STATE_COMPACTION_NOTICE,
    ],
    stateTruncated: true,
  };
  payload = encodeState(candidate);
  if (payload.length > MAX_STATE_PAYLOAD_CHARS) {
    throw new Error(
      "The bounded Seqlane review state is too large to publish safely.",
    );
  }
  return candidate;
}

function preparePublication(
  snapshot: PublicationSnapshot,
  metrics: ReviewRunMetrics,
): {
  readonly report: PublicationReport;
  readonly ledger: PublicationLedger;
  readonly githubRunId: string;
  readonly attempt: number;
} {
  let report = stateReport(reportSchema.parse(snapshot.report));
  const priorLedger = parseLedger(report.runMetricsLedger);
  const githubRunId = /^\d+$/.test(snapshot.githubRunId ?? "")
    ? snapshot.githubRunId!
    : "0";
  const attempt = snapshot.attempt ?? 1;
  const current = {
    githubRunId,
    attempt,
    completedAt: snapshot.completedAt ?? new Date().toISOString(),
    reviewedRevision: report.headRevision,
    metrics,
  };
  const hasCurrentRun = priorLedger.runs.some(
    (run) => run.githubRunId === githubRunId && run.attempt === attempt,
  );
  const evictedRun = !hasCurrentRun && priorLedger.runs.length >= 40;
  const runs = hasCurrentRun
    ? priorLedger.runs
    : [...priorLedger.runs, current].slice(-40);
  const ledger: PublicationLedger = { schemaVersion: 1, runs };
  const limitations = [
    ...report.limitations,
    ...(evictedRun ? [METRICS_LEDGER_TRUNCATION_NOTICE] : []),
    ...(snapshot.eventsTruncated ? [EVENT_TRUNCATION_NOTICE] : []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  report = stateReport({
    ...report,
    limitations: limitations.slice(-20),
    stateTruncated:
      report.stateTruncated || evictedRun || snapshot.eventsTruncated === true,
    runMetricsLedger: ledger,
  });
  return { report, ledger, githubRunId, attempt };
}

export {
  encodeState,
  parseLedger,
  preparePublication,
  shortenUtf8,
  stateReport,
};
