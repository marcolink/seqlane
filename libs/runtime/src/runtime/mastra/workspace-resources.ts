import type { BuiltWorkflow, WorkflowDefinitionRegistry } from "@seqlane/core";
import type {
  WorkspaceResource,
  WorkspaceResourceRegistry,
} from "../workspace/workspace-resource.js";

function resourceIdsForNode(
  node: BuiltWorkflow["plan"]["nodes"][number],
): readonly string[] {
  if (node.type === "task") return [node.taskId];
  if (node.type === "workflow") return [node.workflowId];
  if (node.type === "validation.check" && node.source.type === "task") {
    return [node.source.taskId];
  }
  if (node.type === "repeat") {
    return [
      node.attempt.type === "task"
        ? node.attempt.taskId
        : node.attempt.workflowId,
      ...(node.validation?.source.type === "task"
        ? [node.validation.source.taskId]
        : []),
    ];
  }
  return [];
}

function nestedWorkflowIdForNode(
  node: BuiltWorkflow["plan"]["nodes"][number],
): string | undefined {
  if (node.type === "workflow") return node.workflowId;
  if (node.type === "repeat" && node.attempt.type === "workflow") {
    return node.attempt.workflowId;
  }
  return undefined;
}

export function workspaceResourcesForExecution(
  resources: WorkspaceResourceRegistry,
  workflows: WorkflowDefinitionRegistry | undefined,
): WorkspaceResourceRegistry {
  if (workflows === undefined || workflows.size === 0) return resources;
  const extended = new Map(resources);
  const aggregate = (
    workflowId: string,
    workflow: BuiltWorkflow<unknown, unknown>,
    visiting: ReadonlySet<string>,
  ): readonly WorkspaceResource[] => {
    if (visiting.has(workflowId)) return [];
    const nextVisiting = new Set(visiting).add(workflowId);
    const found = new Map<string, WorkspaceResource>();
    for (const node of workflow.plan.nodes) {
      const nestedWorkflowId = nestedWorkflowIdForNode(node);
      for (const id of resourceIdsForNode(node)) {
        const nested = nestedWorkflowId === id ? workflows.get(id) : undefined;
        const candidates =
          nested === undefined
            ? [extended.get(id)]
            : aggregate(id, nested, nextVisiting);
        for (const candidate of candidates) {
          if (candidate !== undefined) found.set(candidate.key, candidate);
        }
      }
    }
    return [...found.values()];
  };
  for (const [workflowId, workflow] of workflows) {
    const childResources = aggregate(workflowId, workflow, new Set());
    if (childResources.length > 0) {
      extended.set(workflowId, {
        key: childResources.map(({ key }) => key).join("|") || workflowId,
        resources: childResources,
      });
    }
  }
  return extended;
}
