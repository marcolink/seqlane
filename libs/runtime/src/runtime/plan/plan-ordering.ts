import type { Plan, PlanNode, TaskDefinitionRegistry } from "@seqlane/core";
import {
  PlanValidationError,
  validatePlan,
} from "../validation/plan-validation.js";

type NodeWithId = { readonly nodeId: string };

function compareNodes(left: NodeWithId, right: NodeWithId): number {
  if (left.nodeId < right.nodeId) return -1;
  if (left.nodeId > right.nodeId) return 1;
  return 0;
}

function insertReadyNode<T extends NodeWithId>(queue: T[], node: T): void {
  queue.push(node);
  queue.sort(compareNodes);
}

export function orderParsedPlanNodes(plan: Plan): readonly PlanNode[] {
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

export function orderPlanNodes(
  plan: Plan,
  validateDefinitions = true,
  taskDefinitions?: TaskDefinitionRegistry,
): readonly PlanNode[] {
  return orderParsedPlanNodes(
    validatePlan(plan, taskDefinitions, validateDefinitions),
  );
}
