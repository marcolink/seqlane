import type { Plan, PlanNode } from "@seqlane/core";

/**
 * Adds deterministic graph edges between consumers that reuse one session.
 * Branch consumers stay independent because each branch receives its own
 * executor session from the source checkpoint.
 */
export function lowerReuseSessionOrdering(
  nodes: readonly PlanNode[],
): readonly PlanNode[] {
  const lastReuseBySource = new Map<string, string>();

  return nodes.map((node) => {
    if (
      node.type !== "task" ||
      (node.session?.type !== "reuse" && node.session?.type !== "branch")
    ) {
      return node;
    }

    let dependsOn = node.dependsOn;
    if (!dependsOn.includes(node.session.from)) {
      dependsOn = [...dependsOn, node.session.from];
    }

    if (node.session.type !== "reuse") {
      return dependsOn === node.dependsOn ? node : { ...node, dependsOn };
    }

    const previous = lastReuseBySource.get(node.session.from);
    lastReuseBySource.set(node.session.from, node.nodeId);
    if (previous !== undefined && !dependsOn.includes(previous)) {
      dependsOn = [...dependsOn, previous];
    }

    return dependsOn === node.dependsOn ? node : { ...node, dependsOn };
  });
}

/** Returns a Plan whose top-level nodes carry the lowered execution edges. */
export function withLoweredPlanNodes(
  plan: Plan,
  loweredNodes: readonly PlanNode[],
): Plan {
  const loweredById = new Map(loweredNodes.map((node) => [node.nodeId, node]));
  return {
    ...plan,
    nodes: plan.nodes.map((node) => loweredById.get(node.nodeId) ?? node),
  };
}
