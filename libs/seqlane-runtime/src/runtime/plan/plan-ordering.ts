import type { Plan, PlanNode, RepeatNode } from "@seqlane/core";
import {
  PlanValidationError,
  validatePlan,
} from "../validation/plan-validation.js";

type NodeWithId = { readonly nodeId: string };
type RepeatBodyNode = RepeatNode["body"]["nodes"][number];

function compareNodes(left: NodeWithId, right: NodeWithId): number {
  if (left.nodeId < right.nodeId) return -1;
  if (left.nodeId > right.nodeId) return 1;
  return 0;
}

function insertReadyNode<T extends NodeWithId>(queue: T[], node: T): void {
  queue.push(node);
  queue.sort(compareNodes);
}

export function orderRepeatBodyNodes(
  node: RepeatNode,
): readonly RepeatBodyNode[] {
  const nodesById = new Map(
    node.body.nodes.map((bodyNode) => [bodyNode.nodeId, bodyNode]),
  );
  const remainingDependencies = new Map(
    node.body.nodes.map((bodyNode) => [
      bodyNode.nodeId,
      bodyNode.dependsOn.filter((dependency) => nodesById.has(dependency))
        .length,
    ]),
  );
  const dependents = new Map<string, RepeatBodyNode[]>();
  for (const bodyNode of node.body.nodes) {
    for (const dependency of bodyNode.dependsOn) {
      if (!nodesById.has(dependency)) continue;
      const dependentNodes = dependents.get(dependency) ?? [];
      dependentNodes.push(bodyNode);
      dependents.set(dependency, dependentNodes);
    }
  }

  const ready = node.body.nodes
    .filter((bodyNode) => remainingDependencies.get(bodyNode.nodeId) === 0)
    .sort(compareNodes);
  const orderedNodes: RepeatBodyNode[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (!next) continue;
    orderedNodes.push(next);
    for (const dependent of dependents.get(next.nodeId) ?? []) {
      const remaining = (remainingDependencies.get(dependent.nodeId) ?? 0) - 1;
      remainingDependencies.set(dependent.nodeId, remaining);
      if (remaining === 0) insertReadyNode(ready, dependent);
    }
  }

  if (orderedNodes.length !== node.body.nodes.length) {
    throw new Error(`Repeat body "${node.nodeId}" contains a dependency cycle`);
  }
  return orderedNodes;
}

export function orderPlanNodes(plan: Plan): readonly PlanNode[] {
  validatePlan(plan);

  const dependents = new Map<string, PlanNode[]>();
  const remainingDependencies = new Map<string, number>();

  for (const node of plan.nodes) {
    remainingDependencies.set(node.nodeId, node.dependsOn.length);
    for (const dependency of node.dependsOn) {
      const dependentNodes = dependents.get(dependency) ?? [];
      dependentNodes.push(node);
      dependents.set(dependency, dependentNodes);
    }
  }

  const ready = plan.nodes
    .filter(({ nodeId }) => remainingDependencies.get(nodeId) === 0)
    .sort(compareNodes);
  const orderedNodes: PlanNode[] = [];

  while (ready.length > 0) {
    const node = ready.shift();
    if (!node) continue;
    orderedNodes.push(node);

    for (const dependent of dependents.get(node.nodeId) ?? []) {
      const remaining = (remainingDependencies.get(dependent.nodeId) ?? 0) - 1;
      remainingDependencies.set(dependent.nodeId, remaining);
      if (remaining === 0) insertReadyNode(ready, dependent);
    }
  }

  // validatePlan performs this check; keep this guard local to the ordering
  // algorithm so a future validator change cannot produce a partial result.
  if (orderedNodes.length !== plan.nodes.length) {
    throw new PlanValidationError([
      { code: "dependency-cycle", message: "Plan contains a dependency cycle" },
    ]);
  }

  return orderedNodes;
}
