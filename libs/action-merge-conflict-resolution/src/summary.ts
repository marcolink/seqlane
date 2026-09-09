import type {
  ResolutionSummaryReport,
  ResolveMergeConflictsResult,
} from "./contracts.js";
import type { WorkflowDefinitionMetadata } from "./github-port.js";
import {
  formatBoundedRecording,
  type BoundedRecording,
  type SecretRedactor,
} from "./recording.js";

export type { ResolutionSummaryReport } from "./contracts.js";

export const MAX_SUMMARY_TEXT = 1_000;
export const MAX_SUMMARY_TOTAL_CHARS = 12_000;
export const MAX_SUMMARY_ATTEMPTS = 10;
export const MAX_SUMMARY_DECISIONS_PER_ATTEMPT = 32;

type RedactText = (value: string) => string;

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/[\\`*_[\]{}()#+!|<>~=]/g, "\\$&");
}

export function boundedText(
  value: string,
  redactText: RedactText,
  maximumLength = MAX_SUMMARY_TEXT,
  compact = false,
): string {
  const redacted = redactText(value);
  const singleLine = compact
    ? redacted
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : redacted.replace(/[\r\n]+/g, " ");
  if (singleLine.length <= maximumLength) return singleLine;
  return `${singleLine.slice(0, maximumLength - 1)}…`;
}

function shortRevision(value: string): string {
  return value.slice(0, 7);
}

interface RenderedReport {
  readonly lines: string[];
  readonly omittedAttempts: number;
  readonly omittedDecisions: number;
}

function renderAttempt(
  attempt: ResolutionSummaryReport["attempts"][number],
  redactText: RedactText,
): { lines: string[]; omittedDecisions: number } {
  const lines: string[] = [];
  const commit = attempt.commit;
  if (commit === undefined) {
    lines.push(`### Rebase resolution ${attempt.attempt}`);
  } else {
    lines.push(
      `### Rebase resolution ${attempt.attempt}: ${shortRevision(commit.oldSha)} — ${escapeMarkdown(boundedText(commit.subject, redactText))}`,
    );
  }
  lines.push(
    `Model summary: ${escapeMarkdown(boundedText(attempt.summary, redactText))}`,
  );
  const decisions = attempt.decisions.slice(
    0,
    MAX_SUMMARY_DECISIONS_PER_ATTEMPT,
  );
  for (const decision of decisions) {
    lines.push(
      `- ${escapeMarkdown(boundedText(decision.file, redactText))}: ${escapeMarkdown(boundedText(decision.decision, redactText))}`,
    );
  }
  lines.push(
    `Diagnostics: ${attempt.diagnostics.eventCount} bounded event(s); truncated: ${String(attempt.diagnostics.truncated)}`,
  );
  return {
    lines,
    omittedDecisions: Math.max(
      0,
      attempt.decisions.length - MAX_SUMMARY_DECISIONS_PER_ATTEMPT,
    ),
  };
}

function renderResolutionReport(
  report: ResolutionSummaryReport,
  redactText: RedactText,
): RenderedReport {
  const attempts = report.attempts.slice(0, MAX_SUMMARY_ATTEMPTS);
  const lines: string[] = [];
  let omittedDecisions = 0;
  if (report.strategy === "merge") lines.push("### Merge resolution");
  for (const [index, attempt] of attempts.entries()) {
    if (report.strategy === "merge" && index > 0) {
      lines.push(`Attempt ${attempt.attempt}:`);
    }
    const rendered = renderAttempt(attempt, redactText);
    if (report.strategy === "merge") {
      lines.push(...rendered.lines.slice(1));
    } else {
      lines.push(...rendered.lines);
    }
    omittedDecisions += rendered.omittedDecisions;
  }
  return {
    lines,
    omittedAttempts: Math.max(0, report.attempts.length - attempts.length),
    omittedDecisions,
  };
}

function boundedSummary(
  content: string,
  report: RenderedReport | undefined,
): string {
  const reasons: string[] = [];
  if (report?.omittedAttempts !== undefined && report.omittedAttempts > 0) {
    reasons.push(`${report.omittedAttempts} attempt(s)`);
  }
  if (report?.omittedDecisions !== undefined && report.omittedDecisions > 0) {
    reasons.push(`${report.omittedDecisions} decision(s)`);
  }
  const capDigest =
    reasons.length > 0
      ? `Summary truncated: omitted ${reasons.join(" and ")}.`
      : "Summary truncated: character budget exceeded.";
  if (reasons.length === 0 && content.length <= MAX_SUMMARY_TOTAL_CHARS) {
    return content;
  }
  const available = Math.max(0, MAX_SUMMARY_TOTAL_CHARS - capDigest.length - 1);
  return `${content.slice(0, available)}\n${capDigest}`;
}

export interface SummaryWriter {
  readonly write: (
    result: ResolveMergeConflictsResult,
    report?: ResolutionSummaryReport,
  ) => Promise<void>;
}

export function formatResolutionSummary(
  result: ResolveMergeConflictsResult,
  workflow?: WorkflowDefinitionMetadata,
  recording?: BoundedRecording,
  report?: ResolutionSummaryReport,
  redactor?: SecretRedactor,
): string {
  const redactText =
    redactor?.redactText ?? recording?.redactText ?? ((value: string) => value);
  const lines = [`Result: ${result.result}`, `Attempts: ${result.attempts}`];
  if (result.kind !== "error") {
    lines.push(`Strategy: ${result.strategy}`);
    lines.push(`Base: ${result.baseSha}`);
    lines.push(`Head: ${result.headSha}`);
    lines.push(`Pushed: ${String(result.pushed)}`);
  } else {
    lines.push(`Error: ${result.error.category}/${result.error.code}`);
  }
  if (workflow !== undefined) {
    lines.push(
      `Workflow: ${escapeMarkdown(boundedText(workflow.ref, redactText))} (${escapeMarkdown(boundedText(workflow.sha, redactText))})`,
    );
  }
  const renderedReport =
    report === undefined
      ? undefined
      : renderResolutionReport(report, redactText);
  if (renderedReport !== undefined) lines.push(...renderedReport.lines);
  if (recording !== undefined && report === undefined) {
    lines.push(formatBoundedRecording(recording));
  }
  return boundedSummary(lines.join("\n"), renderedReport);
}

export function createSummaryWriter(
  write: (summary: string) => Promise<void>,
  workflow?: WorkflowDefinitionMetadata,
  redactor?: SecretRedactor,
): SummaryWriter {
  return {
    write: (result, report) =>
      write(
        formatResolutionSummary(result, workflow, undefined, report, redactor),
      ),
  };
}
