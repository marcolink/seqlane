import {
  type PublicationLedger,
  type PublicationReport,
} from "./publication-contracts.js";
import { encodeState } from "./publication-state.js";
import { shortenUtf8 } from "./publication-state.js";

type RenderBodyOptions = {
  readonly visibleFindings: number;
  readonly includeVerification: boolean;
};

function safeText(value: string): string {
  return value
    .replace(/\b(?:https?|ftp):\/\/[^\s<>"'`]+/gi, "[external URL omitted]")
    .replace(/\bwww\.[^\s<>"'`]+/gi, "[external URL omitted]")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll(String.fromCharCode(96), "&#96;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("(", "&#40;")
    .replaceAll(")", "&#41;")
    .replaceAll("@", "@&#8203;")
    .replace(/[\r\n]+/g, " ");
}
function severityRank(value: string): number {
  return value === "critical"
    ? 0
    : value === "required"
      ? 1
      : value === "optional"
        ? 2
        : 3;
}
function active(status: string): boolean {
  return (
    status === "new" ||
    status === "open" ||
    status === "addressed" ||
    status === "reopened"
  );
}

function sortFindings(
  findings: PublicationReport["findings"],
): PublicationReport["findings"] {
  return [...findings].sort(
    (left, right) =>
      (active(left.status) ? 0 : 1) - (active(right.status) ? 0 : 1) ||
      severityRank(left.effectiveSeverity) -
        severityRank(right.effectiveSeverity) ||
      left.id.localeCompare(right.id),
  );
}

function renderFindingRows(
  findings: PublicationReport["findings"],
  visibleFindings: number,
  mark: string,
): string[] {
  const visible = findings.slice(0, visibleFindings);
  if (visible.length === 0) return ["✅ No findings."];
  return [
    "| ID | Severity | Status | Area | Finding |",
    "| --- | --- | --- | --- | --- |",
    ...visible.map(
      (finding) =>
        "| " +
        mark +
        safeText(finding.id) +
        mark +
        " | " +
        safeText(finding.effectiveSeverity) +
        " | " +
        safeText(finding.status) +
        " | " +
        safeText(finding.axis) +
        " | " +
        safeText(shortenUtf8(finding.summary, 1_200)) +
        " — " +
        safeText(shortenUtf8(finding.recommendation, 1_200)) +
        " |",
    ),
  ];
}

function renderMetricsSection(
  ledger: PublicationLedger,
  fence: string,
): string[] {
  const totalCost = ledger.runs.reduce(
    (sum, run) => sum + run.metrics.totalCost,
    0,
  );
  return [
    "<details>",
    `<summary>Run metrics (${ledger.runs.length} ${ledger.runs.length === 1 ? "run" : "runs"}) · PR cost: $${totalCost.toFixed(6)} · last run: $${(ledger.runs.at(-1)?.metrics.totalCost ?? 0).toFixed(6)}</summary>`,
    "",
    "Mechanically aggregated from Seqlane execution events:",
    "",
    "<!-- seqlane-code-review-run-metrics-v1-start -->",
    fence + "json",
    JSON.stringify(ledger, null, 2),
    fence,
    "<!-- seqlane-code-review-run-metrics-v1-end -->",
    "",
    "</details>",
  ];
}

function renderVerificationSection(
  report: PublicationReport,
  options: RenderBodyOptions,
): string[] {
  if (!options.includeVerification || report.verification.length === 0)
    return [];
  return [
    "<details>",
    "<summary>Verification evidence (showing up to 10 entries)</summary>",
    "",
    ...report.verification
      .slice(0, 10)
      .map((entry) => "- 🔎 " + safeText(shortenUtf8(entry, 800))),
    "",
    "</details>",
    "",
  ];
}

function renderStateSection(stateEnvelope: string, fence: string): string[] {
  return [
    "<details>",
    "<summary>Machine-readable review state</summary>",
    "",
    "<!-- seqlane-code-review-state-v3-start -->",
    fence + "json",
    stateEnvelope,
    fence,
    "<!-- seqlane-code-review-state-v3-end -->",
    "",
    "</details>",
    "",
  ];
}

function renderPublicationHeader(
  report: PublicationReport,
  metadata: string,
  mark: string,
  blockers: number,
  advisories: number,
): string[] {
  return [
    "<!-- seqlane-code-review -->",
    "<!-- seqlane-code-review-meta-v3: " + metadata + " -->",
    "# Seqlane review",
    "",
    "**" +
      (report.verdict === "approve" ? "✅ Approved" : "🛑 Changes requested") +
      "**" +
      (blockers === 0
        ? ""
        : " · **" +
          blockers +
          " blocker" +
          (blockers === 1 ? "" : "s") +
          "**") +
      (advisories === 0 ? "" : " · **" + advisories + " advisories**"),
    "Static review of " + mark + report.headRevision.slice(0, 8) + mark,
    "",
    safeText(shortenUtf8(report.summary, 2_000)),
    "",
  ];
}

function renderFindingsSection(
  report: PublicationReport,
  findings: PublicationReport["findings"],
  options: RenderBodyOptions,
  mark: string,
): string[] {
  return [
    "## Findings",
    ...renderFindingRows(findings, options.visibleFindings, mark),
    ...(findings.length > options.visibleFindings
      ? [
          "",
          `⚠️ Showing ${options.visibleFindings} of ${findings.length} retained findings.`,
        ]
      : []),
    ...(report.limitations.length === 0
      ? []
      : [
          "",
          "## Review limitations",
          ...report.limitations.map(
            (value) => "- ⚠️ " + safeText(shortenUtf8(value, 800)),
          ),
        ]),
    "",
  ];
}

function renderPublicationBody(
  report: PublicationReport,
  options: RenderBodyOptions,
  ledger: PublicationLedger,
  githubRunId: string,
  attempt: number,
): string {
  const mark = String.fromCharCode(96);
  const fence = mark.repeat(3);
  const metadata = JSON.stringify({
    schemaVersion: 3,
    pullRequestNumber: report.pullRequestNumber,
    reviewedRevision: report.headRevision,
    ...(report.previousReviewedRevision === undefined
      ? {}
      : { previousReviewedRevision: report.previousReviewedRevision }),
    run: { id: githubRunId, attempt },
  });
  const stateEnvelope = JSON.stringify({
    schemaVersion: 3,
    encoding: "gzip+base64",
    data: encodeState(report),
  });
  const findings = sortFindings(report.findings);
  const blockers = findings.filter(
    (finding) =>
      active(finding.status) &&
      ["critical", "required"].includes(finding.effectiveSeverity),
  ).length;
  const advisories = findings.filter(
    (finding) =>
      active(finding.status) && finding.effectiveSeverity === "optional",
  ).length;
  return [
    ...renderPublicationHeader(report, metadata, mark, blockers, advisories),
    ...renderFindingsSection(report, findings, options, mark),
    ...renderMetricsSection(ledger, fence),
    ...renderVerificationSection(report, options),
    ...renderStateSection(stateEnvelope, fence),
    "_Static review only. Review agents did not execute pull-request code, tests, builds, scripts, or checks._",
  ].join("\n");
}

export { renderPublicationBody };
