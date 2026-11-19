import type {
  BuiltWorkflow,
  PlanNode,
  WorkflowDefinitionRegistry,
} from "@seqlane/core";
import type {
  WorkspaceResource,
  WorkspaceResourceRegistry,
} from "./workspace-resource.js";

function runnableResourceId(
  runnable: Extract<PlanNode, { type: "workflow" | "task" }>,
): string {
  return runnable.type === "task" ? runnable.taskId : runnable.workflowId;
}

function strongestPolicy(
  first: "shared" | "exclusive",
  second: "shared" | "exclusive",
): "shared" | "exclusive" {
  return first === "exclusive" || second === "exclusive"
    ? "exclusive"
    : "shared";
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
    const add = (
      resource: WorkspaceResource | undefined,
      policy: "shared" | "exclusive",
    ): void => {
      if (resource === undefined) return;
      const existing = found.get(resource.key);
      found.set(resource.key, {
        key: resource.key,
        requiredPolicy:
          existing === undefined
            ? policy
            : strongestPolicy(existing.requiredPolicy ?? "shared", policy),
      });
    };
    const addRunnable = (id: string, policy: "shared" | "exclusive"): void => {
      const nested = workflows.get(id);
      if (nested === undefined) {
        add(extended.get(id) ?? { key: "seqlane:runtime-workspace" }, policy);
        return;
      }
      for (const resource of aggregate(id, nested, nextVisiting)) {
        add(
          resource,
          strongestPolicy(policy, resource.requiredPolicy ?? "shared"),
        );
      }
    };
    for (const node of workflow.plan.nodes) {
      if (node.type === "task") {
        addRunnable(node.taskId, node.workspace);
      } else if (node.type === "workflow") {
        addRunnable(node.workflowId, node.workspace);
      } else if (node.type === "repeat") {
        addRunnable(runnableResourceId(node.attempt), node.attempt.workspace);
        if (node.validation?.source.type === "task") {
          addRunnable(
            node.validation.source.taskId,
            node.validation.source.workspace,
          );
        }
      } else if (node.type === "choice") {
        addRunnable(runnableResourceId(node.then), node.then.workspace);
        addRunnable(runnableResourceId(node.else), node.else.workspace);
        for (const validation of [
          node.validation?.then,
          node.validation?.else,
        ]) {
          if (validation?.source.type === "task") {
            addRunnable(validation.source.taskId, validation.source.workspace);
          }
        }
      } else if (
        node.type === "validation.check" &&
        node.source.type === "task"
      ) {
        addRunnable(node.source.taskId, node.source.workspace);
      }
    }
    return [...found.values()];
  };
  for (const [workflowId, workflow] of workflows) {
    const childResources = aggregate(workflowId, workflow, new Set());
    if (childResources.length > 0) {
      extended.set(workflowId, {
        key: childResources.map(({ key }) => key).join("|"),
        resources: childResources,
        requiredPolicy: childResources.some(
          ({ requiredPolicy }) => requiredPolicy === "exclusive",
        )
          ? "exclusive"
          : "shared",
      });
    }
  }
  return extended;
}
