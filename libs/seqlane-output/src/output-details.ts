import type {
  SeqlaneDisplayValue,
  SeqlaneInvocationMetrics,
  SeqlaneOutputSummary,
} from "@seqlane/core";
import type { HumanValidationState } from "./event-reducer.js";

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

function formatIssues(validation: HumanValidationState): string {
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

export function formatHumanValidationDetails(
  validation: HumanValidationState,
): readonly string[] {
  const identity =
    "validation " +
    validation.sourceId +
    " (node " +
    validation.validationNodeId +
    ") verdict " +
    validation.verdict +
    (validation.continued ? "; repeat continues" : "");
  const lines = [identity];
  if (validation.verdict === "failed") {
    lines.push("issues " + formatIssues(validation));
  }
  if (validation.evidence !== undefined) {
    lines.push("evidence " + formatEvidence(validation.evidence));
  }
  return lines;
}

export function formatCIValidationDetails(
  validation: HumanValidationState,
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

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? milliseconds + "ms"
    : (milliseconds / 1000).toFixed(1) + "s";
}

function formatHumanTokens(
  metrics: SeqlaneInvocationMetrics,
): string | undefined {
  if (metrics.tokens === undefined) return undefined;
  const total =
    metrics.tokens.total ??
    metrics.tokens.input + metrics.tokens.output + metrics.tokens.reasoning;
  return (
    total +
    " tokens (input " +
    metrics.tokens.input +
    ", output " +
    metrics.tokens.output +
    ", reasoning " +
    metrics.tokens.reasoning +
    ", cache " +
    metrics.tokens.cacheRead +
    "/" +
    metrics.tokens.cacheWrite +
    ")"
  );
}

export function formatHumanOutputDetails(
  metrics: SeqlaneInvocationMetrics | undefined,
  summary: SeqlaneOutputSummary | undefined,
): readonly string[] {
  const lines: string[] = [];
  if (summary !== undefined) {
    const size =
      summary.size === undefined
        ? ""
        : " (" +
          summary.size +
          (summary.kind === "object"
            ? " fields"
            : summary.kind === "array"
              ? " items"
              : summary.kind === "string"
                ? " chars"
                : "") +
          (summary.fields === undefined || summary.fields.length === 0
            ? ")"
            : ": " + summary.fields.join(", ") + ")");
    lines.push("output " + summary.kind + size);
  }
  if (metrics?.durationMs !== undefined) {
    lines.push("duration " + formatDuration(metrics.durationMs));
  }
  const modelAndProvider: string[] = [];
  if (metrics?.model !== undefined) {
    modelAndProvider.push("model " + metrics.model);
  }
  if (metrics?.provider !== undefined) {
    modelAndProvider.push("provider " + metrics.provider);
  }
  if (modelAndProvider.length > 0) {
    lines.push(modelAndProvider.join(" · "));
  }
  if (metrics?.modelSelection !== undefined) {
    const { model, reasoning } = metrics.modelSelection;
    lines.push(
      "selection " +
        model.provider +
        "/" +
        model.model +
        (reasoning === undefined ? "" : " · reasoning " + reasoning),
    );
  }
  const tokens = metrics === undefined ? undefined : formatHumanTokens(metrics);
  if (tokens !== undefined) lines.push(tokens);
  if (metrics?.cost !== undefined) {
    lines.push("cost $" + metrics.cost.toFixed(4));
  }
  return lines;
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
  if (metrics?.tokens !== undefined) {
    const total =
      metrics.tokens.total ??
      metrics.tokens.input + metrics.tokens.output + metrics.tokens.reasoning;
    details.push("tokens=" + total);
    details.push("inputTokens=" + metrics.tokens.input);
    details.push("outputTokens=" + metrics.tokens.output);
    details.push("reasoning=" + metrics.tokens.reasoning);
    details.push("cacheRead=" + metrics.tokens.cacheRead);
    details.push("cacheWrite=" + metrics.tokens.cacheWrite);
  }
  if (metrics?.cost !== undefined) {
    details.push("cost=" + metrics.cost.toFixed(4));
  }
  return details.length === 0 ? undefined : details.join(" ");
}
