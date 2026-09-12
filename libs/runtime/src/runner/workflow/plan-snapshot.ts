import type { Plan, PlanNode } from "@seqlane/core";
import type {
  SeqlanePlanNodeSnapshot,
  SeqlanePlanSnapshot,
} from "@seqlane/events";
import { orderPlanNodes } from "../../runtime/plan/plan-ordering.js";

const MAX_PLAN_NODE_ID_LENGTH = 256;
const MAX_TASK_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 512;

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function compareNodes(left: PlanNode, right: PlanNode): number {
  return left.nodeId.localeCompare(right.nodeId);
}

function orderGraphNodes(nodes: readonly PlanNode[]): readonly PlanNode[] {
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const remainingDependencies = new Map(
    nodes.map((node) => [
      node.nodeId,
      node.dependsOn.filter((dependency) => nodesById.has(dependency)).length,
    ]),
  );
  const dependents = new Map<string, PlanNode[]>();

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodesById.has(dependency)) continue;
      const dependencyDependents = dependents.get(dependency) ?? [];
      dependencyDependents.push(node);
      dependents.set(dependency, dependencyDependents);
    }
  }

  const ready = nodes
    .filter((node) => remainingDependencies.get(node.nodeId) === 0)
    .sort(compareNodes);
  const ordered: PlanNode[] = [];

  while (ready.length > 0) {
    const node = ready.shift();
    if (!node) continue;
    ordered.push(node);

    for (const dependent of dependents.get(node.nodeId) ?? []) {
      const remaining = (remainingDependencies.get(dependent.nodeId) ?? 0) - 1;
      remainingDependencies.set(dependent.nodeId, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareNodes);
      }
    }
  }

  return ordered.length === nodes.length ? ordered : nodes;
}

function nodeLabel(node: PlanNode): string {
  switch (node.type) {
    case "task":
      return node.taskId;
    case "workflow":
      return node.workflowId;
    case "validation.check":
      return node.source.type === "task"
        ? node.source.taskId
        : node.source.validatorId;
    case "validation.gate":
    case "repeat":
      return node.nodeId;
  }
}

function nodeTaskId(node: PlanNode): string | undefined {
  if (node.type === "task") return bounded(node.taskId, MAX_TASK_ID_LENGTH);
  if (node.type === "validation.check" && node.source.type === "task") {
    return bounded(node.source.taskId, MAX_TASK_ID_LENGTH);
  }
  return undefined;
}

function nodeSession(
  node: PlanNode,
  serializedIds: ReadonlyMap<string, string>,
) {
  if (node.type !== "task") return undefined;
  const session = node.session;
  if (session === undefined) return undefined;
  if (session.type === "isolated") return session;
  const from = serializedIds.get(session.from);
  if (from === undefined) return undefined;
  if (session.type === "reuse") return { type: session.type, from };
  return {
    type: session.type,
    from,
    ...(session.model === undefined ? {} : { model: session.model }),
  };
}

export function createSeqlanePlanSnapshot(plan: Plan): SeqlanePlanSnapshot {
  const topLevelNodes = orderPlanNodes(plan, false);
  const allNodes: PlanNode[] = [];
  const collectNodes = (nodes: readonly PlanNode[]): void => {
    for (const node of nodes) {
      allNodes.push(node);
      if (node.type === "repeat") collectNodes(node.body.nodes);
    }
  };
  collectNodes(topLevelNodes);

  const serializedIds = new Map(
    allNodes.map((node) => [
      node.nodeId,
      bounded(node.nodeId, MAX_PLAN_NODE_ID_LENGTH),
    ]),
  );

  const snapshots: SeqlanePlanNodeSnapshot[] = [];
  const appendNodes = (
    nodes: readonly PlanNode[],
    parentPlanNodeId: string | undefined,
  ): void => {
    const orderedNodes = orderGraphNodes(nodes);
    const graphNodeIds = new Set(orderedNodes.map((node) => node.nodeId));

    for (const [siblingOrder, node] of orderedNodes.entries()) {
      const serializedNodeId = serializedIds.get(node.nodeId);
      if (serializedNodeId === undefined) continue;
      const dependsOn = node.dependsOn.flatMap((dependency) => {
        if (!graphNodeIds.has(dependency)) return [];
        const serializedDependency = serializedIds.get(dependency);
        return serializedDependency === undefined ? [] : [serializedDependency];
      });
      const serializedParent =
        parentPlanNodeId === undefined
          ? undefined
          : serializedIds.get(parentPlanNodeId);
      const taskId = nodeTaskId(node);
      const session = nodeSession(node, serializedIds);
      snapshots.push({
        planNodeId: serializedNodeId,
        type: node.type,
        label: bounded(nodeLabel(node), MAX_LABEL_LENGTH),
        dependsOn,
        siblingOrder,
        ...(taskId === undefined ? {} : { taskId }),
        ...(session === undefined ? {} : { session }),
        ...(serializedParent === undefined
          ? {}
          : { parentPlanNodeId: serializedParent }),
        ...(node.type === "repeat"
          ? { maximumIterations: node.maximumIterations }
          : {}),
      });
    }

    for (const node of orderedNodes) {
      if (node.type === "repeat") appendNodes(node.body.nodes, node.nodeId);
    }
  };

  appendNodes(topLevelNodes, undefined);

  return {
    workflow: {
      id: bounded(plan.workflow.id, MAX_PLAN_NODE_ID_LENGTH),
      ...(plan.workflow.version === undefined
        ? {}
        : { version: bounded(plan.workflow.version, 128) }),
    },
    nodes: snapshots,
  };
}
