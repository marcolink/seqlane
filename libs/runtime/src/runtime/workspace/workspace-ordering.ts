import type {
  PlanNode,
  PlanNodeId,
  RepeatNode,
  TaskNode,
  WorkflowNode,
} from "@seqlane/core";
import type {
  WorkspaceResource,
  WorkspaceResourceRegistry,
} from "./workspace-resource.js";

const DEFAULT_WORKSPACE_RESOURCE = "seqlane:runtime-workspace";
const defaultWorkspaceResource: WorkspaceResource = {
  key: DEFAULT_WORKSPACE_RESOURCE,
};

export class WorkspaceConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConstraintError";
  }
}

export interface WorkspaceAccess {
  readonly policy: "shared" | "exclusive";
  readonly resourceKey: string;
}

interface ResolvedWorkspaceAccess extends WorkspaceAccess {
  readonly nodeId: PlanNodeId;
}

function taskWorkspace(
  taskId: string,
  policy: TaskNode["workspace"],
  workspaceResources: WorkspaceResourceRegistry | undefined,
): WorkspaceAccess {
  const resourceKey =
    workspaceResourcesForId(taskId, workspaceResources)[0]?.key ??
    DEFAULT_WORKSPACE_RESOURCE;
  if (typeof resourceKey !== "string" || resourceKey.length === 0) {
    throw new WorkspaceConstraintError(
      `Task "${taskId}" has an invalid workspace resource identity`,
    );
  }
  return { policy, resourceKey };
}

function workspaceResourcesForId(
  id: string,
  workspaceResources: WorkspaceResourceRegistry | undefined,
): readonly WorkspaceResource[] {
  const resource = workspaceResources?.get(id);
  if (resource === undefined) return [defaultWorkspaceResource];
  return resource.resources === undefined || resource.resources.length === 0
    ? [resource]
    : resource.resources;
}

export function workspaceResourcesForPlanNode(
  node: PlanNode,
  workspaceResources?: WorkspaceResourceRegistry,
): readonly WorkspaceResource[] {
  if (node.type === "task")
    return workspaceResourcesForId(node.taskId, workspaceResources);
  if (node.type === "workflow")
    return workspaceResourcesForId(node.workflowId, workspaceResources);
  if (node.type === "validation.check" && node.source.type === "task") {
    return workspaceResourcesForId(node.source.taskId, workspaceResources);
  }
  return [defaultWorkspaceResource];
}

function workflowWorkspace(
  workflowId: string,
  policy: WorkflowNode["workspace"],
  workspaceResources: WorkspaceResourceRegistry | undefined,
): WorkspaceAccess {
  return taskWorkspace(workflowId, policy, workspaceResources);
}

function workspaceAccessesForNode(
  node: PlanNode,
  workspaceResources: WorkspaceResourceRegistry | undefined,
): readonly ResolvedWorkspaceAccess[] {
  if (node.type === "task") {
    return workspaceResourcesForPlanNode(node, workspaceResources).map(
      (resource) => ({
        policy: node.workspace,
        resourceKey: resource.key,
        nodeId: node.nodeId,
      }),
    );
  }
  if (node.type === "workflow") {
    return workspaceResourcesForPlanNode(node, workspaceResources).map(
      (resource) => ({
        policy: node.workspace,
        resourceKey: resource.key,
        nodeId: node.nodeId,
      }),
    );
  }
  if (node.type === "validation.check" && node.source.type === "task") {
    return [
      {
        ...taskWorkspace(
          node.source.taskId,
          node.source.workspace,
          workspaceResources,
        ),
        nodeId: node.nodeId,
      },
    ];
  }
  if (node.type === "repeat") {
    return workspaceAccessesForRepeat(node, workspaceResources);
  }
  return [];
}

function workspaceAccessesForRepeat(
  node: RepeatNode,
  workspaceResources: WorkspaceResourceRegistry | undefined,
): readonly ResolvedWorkspaceAccess[] {
  const accesses = new Map<string, WorkspaceAccess>();
  for (const bodyNode of [node.attempt]) {
    const access =
      bodyNode.type === "task"
        ? taskWorkspace(bodyNode.taskId, bodyNode.workspace, workspaceResources)
        : workflowWorkspace(
            bodyNode.workflowId,
            bodyNode.workspace,
            workspaceResources,
          );
    if (access === undefined) continue;
    const previous = accesses.get(access.resourceKey);
    accesses.set(access.resourceKey, {
      resourceKey: access.resourceKey,
      policy:
        previous?.policy === "exclusive" || access.policy === "exclusive"
          ? "exclusive"
          : "shared",
    });
  }
  return [...accesses.values()].map((access) => ({
    ...access,
    nodeId: node.nodeId,
  }));
}

function workspaceAccessForNode(
  node: PlanNode,
  workspaceResources: WorkspaceResourceRegistry | undefined,
): ResolvedWorkspaceAccess | undefined {
  return workspaceAccessesForNode(node, workspaceResources)[0];
}

function conflicts(left: WorkspaceAccess, right: WorkspaceAccess): boolean {
  return (
    left.resourceKey === right.resourceKey &&
    (left.policy === "exclusive" || right.policy === "exclusive")
  );
}

function hasDependencyPath(
  dependencies: ReadonlyMap<PlanNodeId, ReadonlySet<PlanNodeId>>,
  start: PlanNodeId,
  target: PlanNodeId,
): boolean {
  const pending = [start];
  const visited = new Set<PlanNodeId>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const dependency of dependencies.get(current) ?? []) {
      if (dependency === target) return true;
      pending.push(dependency);
    }
  }
  return false;
}

function assertAcyclic(nodes: readonly PlanNode[]): void {
  const nodeIds = new Set(nodes.map(({ nodeId }) => nodeId));
  const remaining = new Map(
    nodes.map((node) => [
      node.nodeId,
      node.dependsOn.filter((dependency) => nodeIds.has(dependency)).length,
    ]),
  );
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodeIds.has(dependency)) continue;
      const children = dependents.get(dependency) ?? [];
      children.push(node.nodeId);
      dependents.set(dependency, children);
    }
  }

  const ready = nodes
    .filter(({ nodeId }) => remaining.get(nodeId) === 0)
    .map(({ nodeId }) => nodeId)
    .sort();
  let visited = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift();
    if (nodeId === undefined) continue;
    visited += 1;
    for (const dependent of dependents.get(nodeId) ?? []) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (visited !== nodes.length) {
    throw new WorkspaceConstraintError(
      "Workspace constraints introduced a dependency cycle",
    );
  }
}

/**
 * Adds graph edges for statically known workspace conflicts.
 *
 * The input must already be in deterministic topological order. An unordered
 * compatible pair remains unordered, while an exclusive/shared pair on the
 * same resolved resource is serialized in that order. Resource identities are
 * runtime-resolved before compilation; an absent identity uses the same
 * runtime-workspace identity as the invocation path.
 */
export function lowerWorkspaceOrdering(
  nodes: readonly PlanNode[],
  workspaceResources?: WorkspaceResourceRegistry,
): readonly PlanNode[] {
  const accesses = nodes.map((node) =>
    workspaceAccessesForNode(node, workspaceResources),
  );
  const dependencies = new Map(
    nodes.map((node) => [node.nodeId, new Set(node.dependsOn)]),
  );

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = accesses[leftIndex] ?? [];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < nodes.length;
      rightIndex += 1
    ) {
      const right = accesses[rightIndex] ?? [];
      if (
        !left.some((leftAccess) =>
          right.some((rightAccess) => conflicts(leftAccess, rightAccess)),
        )
      ) {
        continue;
      }

      const leftNodeId = nodes[leftIndex]?.nodeId;
      const rightNodeId = nodes[rightIndex]?.nodeId;
      if (leftNodeId === undefined || rightNodeId === undefined) continue;

      // Existing data/session ordering already serializes the pair in either
      // direction. Keep that order instead of adding a contradictory edge.
      if (
        hasDependencyPath(dependencies, leftNodeId, rightNodeId) ||
        hasDependencyPath(dependencies, rightNodeId, leftNodeId)
      ) {
        continue;
      }

      dependencies.get(rightNodeId)?.add(leftNodeId);
    }
  }

  const lowered = nodes.map((node) => {
    const dependsOn = [...(dependencies.get(node.nodeId) ?? [])];
    return dependsOn.length === node.dependsOn.length
      ? node
      : { ...node, dependsOn };
  });
  assertAcyclic(lowered);
  return lowered;
}

export function workspaceAccessForPlanNode(
  node: PlanNode,
  workspaceResources?: WorkspaceResourceRegistry,
): WorkspaceAccess | undefined {
  return workspaceAccessForNode(node, workspaceResources);
}
