import {
  type PublicationLedger,
  type PublicationReport,
} from "./publication-contracts.js";
import {
  MAX_PUBLICATION_BODY_BYTES,
  MAX_PUBLICATION_BODY_CHARS,
  stateReport,
} from "./publication-state.js";
import { renderPublicationBody } from "./publication-rendering.js";

function shortenUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  const suffix = new TextEncoder().encode("…");
  const bounded = bytes.subarray(0, Math.max(0, maxBytes - suffix.length));
  return new TextDecoder().decode(bounded) + "…";
}

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
      { visibleFindings: 0, includeVerification: false },
      boundedLedger,
      githubRunId,
      attempt,
    ),
  };
}

function fitPublicationBody(
  initialReport: PublicationReport,
  ledger: PublicationLedger,
  githubRunId: string,
  attempt: number,
): { readonly report: PublicationReport; readonly body: string } {
  let report = initialReport;
  let body = renderPublicationBody(
    report,
    { visibleFindings: 20, includeVerification: true },
    ledger,
    githubRunId,
    attempt,
  );
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    report = compactPublicationReport(report);
    body = renderPublicationBody(
      report,
      { visibleFindings: 20, includeVerification: true },
      ledger,
      githubRunId,
      attempt,
    );
  }
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    body = renderPublicationBody(
      report,
      { visibleFindings: 0, includeVerification: false },
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
