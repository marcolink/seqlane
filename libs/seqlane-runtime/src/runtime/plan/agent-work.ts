import type { Plan, PlanNode } from "@seqlane/core";

function nodeContainsAgentWork(node: PlanNode): boolean {
  if (node.type === "task") return node.execution !== "local";
  if (node.type === "validation.check") return node.source.type === "task";
  if (node.type === "validation.gate") return false;
  return node.body.nodes.some(nodeContainsAgentWork);
}

/** Returns whether a Plan contains agent work at any supported nesting level. */
export function planContainsAgentWork(plan: Plan): boolean {
  return plan.nodes.some(nodeContainsAgentWork);
}
