import type { ResolveMergeConflictsResult } from "./contracts.js";
import type { WorkflowDefinitionMetadata } from "./github-port.js";

export interface SummaryWriter {
  readonly write: (result: ResolveMergeConflictsResult) => Promise<void>;
}

export function formatResolutionSummary(
  result: ResolveMergeConflictsResult,
  workflow?: WorkflowDefinitionMetadata,
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
    lines.push(`Workflow: ${workflow.ref} (${workflow.sha})`);
  }
  return lines.join("\n");
}

export function createSummaryWriter(
  write: (summary: string) => Promise<void>,
  workflow?: WorkflowDefinitionMetadata,
): SummaryWriter {
  return {
    write: (result) => write(formatResolutionSummary(result, workflow)),
  };
}
