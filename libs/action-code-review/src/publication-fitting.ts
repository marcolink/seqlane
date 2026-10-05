import {
  type PublicationLedger,
  type PublicationReport,
} from "./publication-contracts.js";
import {
  MAX_PUBLICATION_BODY_BYTES,
  MAX_PUBLICATION_BODY_CHARS,
  shortenUtf8,
  stateReport,
} from "./publication-state.js";
import { renderPublicationBody } from "./publication-rendering.js";

function publicationBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function compactPublicationReport(
  report: PublicationReport,
): PublicationReport {
  return stateReport({
    ...report,
    summary: shortenUtf8(report.summary, 1_000),
    findings: report.findings.map((finding) => ({
      ...finding,
      summary: shortenUtf8(finding.summary, 320),
      recommendation: shortenUtf8(finding.recommendation, 320),
    })),
    verification: report.verification.map((entry) => shortenUtf8(entry, 320)),
    limitations: [
      ...report.limitations,
      "Review text was compacted to fit the publication limit.",
    ].slice(-20),
    stateTruncated: true,
  });
}

function compactLedger(ledger: PublicationLedger): PublicationLedger {
  return {
    schemaVersion: 1,
    runs: ledger.runs.map((run) => ({
      ...run,
      metrics: { ...run.metrics, tasks: [] },
    })),
  };
}

function compactLedgerPublication(
  report: PublicationReport,
  ledger: PublicationLedger,
  githubRunId: string,
  attempt: number,
): { readonly report: PublicationReport; readonly body: string } {
  const boundedLedger = compactLedger(ledger);
  const compactedReport = stateReport({
    ...report,
    limitations: [
      ...report.limitations,
      "Detailed task metrics were compacted to fit the publication limit.",
    ].slice(-20),
    stateTruncated: true,
    runMetricsLedger: boundedLedger,
  });
  return {
    report: compactedReport,
    body: renderPublicationBody(
      compactedReport,
      {
        visibleFindings: 20,
        includeVerification: true,
        compactMetrics: true,
      },
      boundedLedger,
      githubRunId,
      attempt,
    ),
  };
}

function fitFindingProjection(
  report: PublicationReport,
  githubRunId: string,
  attempt: number,
): string {
  // Keep the highest-priority rows that fit after compacting metrics.
  for (
    let visibleFindings = Math.min(20, report.findings.length);
    visibleFindings >= Math.min(1, report.findings.length);
    visibleFindings -= 1
  ) {
    const body = renderPublicationBody(
      report,
      {
        visibleFindings,
        includeVerification: false,
        compactMetrics: true,
      },
      report.runMetricsLedger,
      githubRunId,
      attempt,
    );
    if (publicationBytes(body) <= MAX_PUBLICATION_BODY_BYTES) return body;
  }
  throw new Error(
    "The bounded Seqlane review publication is too large to publish safely.",
  );
}

function fitPublicationBody(
  initialReport: PublicationReport,
  ledger: PublicationLedger,
  githubRunId: string,
  attempt: number,
): { readonly report: PublicationReport; readonly body: string } {
  let report = initialReport;
  const fullProjection = { visibleFindings: 20, includeVerification: true };
  let body = renderPublicationBody(
    report,
    fullProjection,
    ledger,
    githubRunId,
    attempt,
  );
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    body = renderPublicationBody(
      report,
      { ...fullProjection, compactMetrics: true },
      ledger,
      githubRunId,
      attempt,
    );
  }
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    report = compactPublicationReport(report);
    body = renderPublicationBody(
      report,
      { ...fullProjection, compactMetrics: true },
      ledger,
      githubRunId,
      attempt,
    );
  }
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    ({ report, body } = compactLedgerPublication(
      report,
      ledger,
      githubRunId,
      attempt,
    ));
  }
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    body = fitFindingProjection(report, githubRunId, attempt);
  }
  if (
    publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES ||
    body.length > MAX_PUBLICATION_BODY_CHARS
  ) {
    throw new Error(
      "The bounded Seqlane review publication is too large to publish safely.",
    );
  }
  return { report, body };
}

export { fitPublicationBody };
