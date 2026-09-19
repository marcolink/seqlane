import type { RunNode } from "../run-view-model.js";

export function formatReportedCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export function usageSummary(node: RunNode, compact = false): string {
  const metrics = node.output.metrics;
  const parts: string[] = [];
  const calls = node.completedToolIds?.size;
  if (calls && !compact)
    parts.push(`${calls >= 1000 ? ">=" : ""}${calls} tool calls completed`);
  if (!compact && metrics?.tokens) {
    parts.push(tokenSummary(metrics.tokens));
  }
  if (!compact) {
    const tools = namedUsageSummary("tools", node.toolUsage);
    if (tools) parts.push(tools);
    const skills = namedUsageSummary("skills", node.skillUsage);
    if (skills) parts.push(skills);
  }
  if (metrics?.cost !== undefined) parts.push(formatReportedCost(metrics.cost));
  return parts.join(" · ");
}

function tokenSummary(
  tokens: NonNullable<NonNullable<RunNode["output"]["metrics"]>["tokens"]>,
): string {
  const { input, output, reasoning, cacheRead, cacheWrite } = tokens;
  return [
    `tokens input=${input}`,
    `output=${output}`,
    `reasoning=${reasoning}`,
    `cacheRead=${cacheRead}`,
    `cacheWrite=${cacheWrite}`,
  ].join(" ");
}

function namedUsageSummary(
  label: "tools" | "skills",
  usage: ReadonlyMap<string, number>,
): string | undefined {
  if (usage.size === 0) return undefined;
  return `${label} ${[...usage]
    .map(([name, count]) => `${name}=${count}`)
    .join(" ")}`;
}
