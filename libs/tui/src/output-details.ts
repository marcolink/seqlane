import type {
  SeqlaneDisplayValue,
  SeqlaneInvocationMetrics,
  SeqlaneOutputSummary,
} from "@seqlane/core";
import type { RunValidationState } from "./run-view-model.js";

const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const CONTROL_CHARACTER_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`,
  "g",
);

function compact(value: string, maximum = 500): string {
  const normalized = value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maximum
    ? normalized
    : normalized.slice(0, Math.max(0, maximum - 1)) + "…";
}

function formatEvidence(value: SeqlaneDisplayValue): string {
  switch (value.state) {
    case "present":
      return "present " + compact(JSON.stringify(value.value));
    case "redacted":
      return "redacted";
    case "truncated":
      return "truncated";
    case "omitted":
      return "omitted (" + value.reason + ")";
  }
}

function formatIssues(validation: RunValidationState): string {
  if (validation.issues.length === 0) return "none";
  return validation.issues
    .map(
      (issue) =>
        compact(issue.code, 120) +
        ": " +
        compact(issue.message, 240) +
        (issue.path === undefined ? "" : " @" + compact(issue.path, 120)),
    )
    .join("; ");
}

export function formatValidationDetails(
  validation: RunValidationState,
): string {
  const evidence =
    validation.evidence === undefined
      ? undefined
      : " evidence=" + formatEvidence(validation.evidence);
  return (
    "validation source=" +
    compact(validation.sourceId, 160) +
    " node=" +
    compact(validation.validationNodeId, 160) +
    " verdict=" +
    validation.verdict +
    " issues=" +
    compact(formatIssues(validation), 500) +
    (validation.continued ? " continued=true" : " continued=false") +
    (evidence ?? "")
  );
}

export function formatCITokenDetails(
  metrics: SeqlaneInvocationMetrics | undefined,
): string | undefined {
  if (metrics?.tokens === undefined) return undefined;
  const total =
    metrics.tokens.total ??
    metrics.tokens.input + metrics.tokens.output + metrics.tokens.reasoning;
  return [
    "tokens=" + total,
    "inputTokens=" + metrics.tokens.input,
    "outputTokens=" + metrics.tokens.output,
    "reasoning=" + metrics.tokens.reasoning,
    "cacheRead=" + metrics.tokens.cacheRead,
    "cacheWrite=" + metrics.tokens.cacheWrite,
  ].join(" ");
}

export function formatCICost(cost: number): string {
  return cost.toFixed(4);
}

export function formatCICostDetails(
  metrics: SeqlaneInvocationMetrics | undefined,
): string | undefined {
  return metrics?.cost === undefined
    ? undefined
    : "cost=" + formatCICost(metrics.cost);
}

export function formatCIOutputDetails(
  metrics: SeqlaneInvocationMetrics | undefined,
  summary: SeqlaneOutputSummary | undefined,
): string | undefined {
  const details: string[] = [];
  if (summary !== undefined) {
    details.push("summary=" + summary.kind);
    if (summary.size !== undefined) details.push("size=" + summary.size);
    if (summary.fields !== undefined && summary.fields.length > 0) {
      details.push(
        "fields=" + summary.fields.map((field) => compact(field, 80)).join(","),
      );
    }
  }
  if (metrics?.durationMs !== undefined) {
    details.push("duration=" + metrics.durationMs + "ms");
  }
  if (metrics?.model !== undefined) {
    details.push("model=" + compact(metrics.model, 200));
  }
  if (metrics?.provider !== undefined) {
    details.push("provider=" + compact(metrics.provider, 200));
  }
  if (metrics?.modelSelection !== undefined) {
    const { model, reasoning } = metrics.modelSelection;
    details.push(
      "selection=" +
        compact(model.provider, 120) +
        "/" +
        compact(model.model, 200),
    );
    if (reasoning !== undefined) {
      details.push("reasoning=" + compact(reasoning, 120));
    }
  }
  const tokenDetails = formatCITokenDetails(metrics);
  if (tokenDetails !== undefined) details.push(tokenDetails);
  const costDetails = formatCICostDetails(metrics);
  if (costDetails !== undefined) details.push(costDetails);
  return details.length === 0 ? undefined : details.join(" ");
}
