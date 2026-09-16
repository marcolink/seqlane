import type { RunNode } from "../run-view-model.js";

export function formatReportedCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export function usageSummary(node: RunNode, compact = false): string {
  const metrics = node.output.metrics;
  const parts: string[] = [];
  const calls = node.completedToolIds?.size;
  if (calls)
    parts.push(
      `${calls >= 1000 ? ">=" : ""}${calls} ${compact ? "calls" : "tool calls completed"}`,
    );
  if (metrics?.tokens) {
    parts.push(tokenSummary(metrics.tokens, compact));
  }
  if (metrics?.cost !== undefined) parts.push(formatReportedCost(metrics.cost));
  return parts.join(" · ");
}

function tokenSummary(
  tokens: NonNullable<NonNullable<RunNode["output"]["metrics"]>["tokens"]>,
  compact: boolean,
): string {
  const { input, output, reasoning, cacheRead, cacheWrite, total } = tokens;
  if (compact) return `${total ?? input + output + reasoning} tokens`;
  const parts = [`in ${input} · out ${output}`];
  if (reasoning) parts.push(`reasoning ${reasoning}`);
  if (cacheRead || cacheWrite)
    parts.push(`cache read ${cacheRead} / write ${cacheWrite}`);
  return parts.join(" · ");
}
