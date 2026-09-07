import type {
  ResolutionSummaryReport,
  ResolveMergeConflictsResult,
} from "./contracts.js";
import type { WorkflowDefinitionMetadata } from "./github-port.js";
import { formatBoundedRecording, type BoundedRecording } from "./recording.js";

export type { ResolutionSummaryReport } from "./contracts.js";

const MAX_SUMMARY_TEXT = 1_000;

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/[\\`*_[\]{}()#+!|<>~=]/g, "\\$&");
}

function boundedText(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, " ");
  if (singleLine.length <= MAX_SUMMARY_TEXT) return singleLine;
  return `${singleLine.slice(0, MAX_SUMMARY_TEXT - 1)}…`;
}

function shortRevision(value: string): string {
  return value.slice(0, 7);
}

function renderAttempt(
  attempt: ResolutionSummaryReport["attempts"][number],
): string[] {
  const lines: string[] = [];
  const commit = attempt.commit;
  if (commit === undefined) {
    lines.push(`### Rebase resolution ${attempt.attempt}`);
  } else {
    lines.push(
      `### Rebase resolution ${attempt.attempt}: ${shortRevision(commit.oldSha)} — ${escapeMarkdown(boundedText(commit.subject))}`,
    );
  }
  lines.push(`Model summary: ${escapeMarkdown(boundedText(attempt.summary))}`);
  for (const decision of attempt.decisions) {
    lines.push(
      `- ${escapeMarkdown(boundedText(decision.file))}: ${escapeMarkdown(boundedText(decision.decision))}`,
    );
  }
  return lines;
}

function renderResolutionReport(report: ResolutionSummaryReport): string[] {
  if (report.attempts.length === 0) return [];
  if (report.strategy === "merge") {
    const lines = ["### Merge resolution"];
    for (const [index, attempt] of report.attempts.entries()) {
      if (index > 0) lines.push(`Attempt ${attempt.attempt}:`);
      lines.push(
        `Model summary: ${escapeMarkdown(boundedText(attempt.summary))}`,
      );
      for (const decision of attempt.decisions) {
        lines.push(
          `- ${escapeMarkdown(boundedText(decision.file))}: ${escapeMarkdown(boundedText(decision.decision))}`,
        );
      }
    }
    return lines;
  }
  return report.attempts.flatMap(renderAttempt);
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
): string {
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
      `Workflow: ${escapeMarkdown(workflow.ref)} (${escapeMarkdown(workflow.sha)})`,
    );
  }
  if (report !== undefined) lines.push(...renderResolutionReport(report));
  if (recording !== undefined) lines.push(formatBoundedRecording(recording));
  return lines.join("\n");
}

export function createSummaryWriter(
  write: (summary: string) => Promise<void>,
  workflow?: WorkflowDefinitionMetadata,
  recording?: BoundedRecording,
): SummaryWriter {
  return {
    write: (result, report) =>
      write(formatResolutionSummary(result, workflow, recording, report)),
  };
}
