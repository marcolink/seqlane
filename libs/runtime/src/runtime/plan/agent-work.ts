import type { Plan, PlanNode } from "@seqlane/core";

function nodeContainsAgentWork(node: PlanNode): boolean {
  // The executable task contract intentionally does not serialize an
  // implementation kind. Ordinary tasks may call either local or agent work
  // from their private execute function, so only task-backed validators have
  // an explicit agent-work shape in the Plan.
  if (node.type === "task") return false;
  if (node.type === "validation.check") return node.source.type === "task";
  if (node.type === "validation.gate") return false;
  if (node.type === "workflow") return false;
  return nodeContainsAgentWork(node.attempt);
}

/** Returns whether a Plan contains agent work at any supported nesting level. */
export function planContainsAgentWork(plan: Plan): boolean {
  return plan.nodes.some(nodeContainsAgentWork);
}
