import type { PreparedPlanExecution } from "../compile/compile-plan.js";
import { invocationIdForNode } from "../execution/context.js";
import type { AgentAdapterCapabilities } from "@seqlane/agent-adapter";
import type { PlanNode, TaskNode } from "@seqlane/core";
import {
  resolveTaskSession,
  type SessionConsumer,
} from "./session-resolution.js";
import {
  preflightSharedSessionOrder,
  rejectUnorderedSharedSessionPairs,
} from "./shared-session-order.js";

export type SessionCapability =
  | "execute"
  | "structuredOutput"
  | "modelSelection"
  | "sessionReuse"
  | "checkpoint"
  | "fork";

export class UnsupportedSessionCapabilityError extends Error {
  constructor(
    readonly nodeId: string,
    readonly capability: SessionCapability,
    readonly adapterCapabilities: AgentAdapterCapabilities,
  ) {
    super(
      `Agent adapter cannot satisfy "${capability}" for session policy at "${nodeId}"`,
    );
    this.name = "UnsupportedSessionCapabilityError";
  }
}

function agentTaskNodes(compiled: CompiledPlan): readonly TaskNode[] {
  const nodes: TaskNode[] = [];
  const visit = (node: PlanNode): void => {
    if (node.type === "task") {
      if (node.execution !== "local") nodes.push(node);
      return;
    }
    if (node.type === "repeat") {
      for (const bodyNode of node.body.nodes) visit(bodyNode);
      return;
    }
    if (node.type === "validation.check" && node.source.type === "task") {
      nodes.push({
        type: "task",
        taskId: node.source.taskId,
        nodeId: node.nodeId,
        workspace: node.source.workspace,
        input: node.input,
        dependsOn: node.dependsOn,
      });
    }
  };
  for (const node of compiled.plan.nodes) visit(node);
  return nodes;
}

function requireCapability(
  nodeId: string,
  capabilities: AgentAdapterCapabilities,
  capability: SessionCapability,
): void {
  if (!capabilities[capability]) {
    throw new UnsupportedSessionCapabilityError(
      nodeId,
      capability,
      capabilities,
    );
  }
}

/** Checks static session and model requirements before creating any session. */
export function preflightCompiledWorkflowSessionCapabilities(
  compiled: CompiledPlan,
): void {
  const capabilities = compiled.context.sessionResolver?.adapterCapabilities;
  if (capabilities === undefined) return;

  for (const node of agentTaskNodes(compiled)) {
    requireCapability(node.nodeId, capabilities, "execute");
    requireCapability(node.nodeId, capabilities, "structuredOutput");
    const policy = node.session ?? { type: "isolated" as const };
    const explicitSelection =
      (policy.type === "isolated" || policy.type === "branch"
        ? policy.model
        : undefined) ??
      compiled.context.effectiveModelSelections.get(
        compiled.context.invocationIds.get(node.nodeId) ?? node.nodeId,
      );
    if (explicitSelection !== undefined) {
      requireCapability(node.nodeId, capabilities, "modelSelection");
    }
    if (policy.type === "reuse") {
      requireCapability(node.nodeId, capabilities, "sessionReuse");
    }
    if (policy.type === "branch") {
      requireCapability(node.nodeId, capabilities, "checkpoint");
      requireCapability(node.nodeId, capabilities, "fork");
    }
  }
}

/** Resolves executor sessions and validates session admission before execution. */
export async function resolveCompiledWorkflowSessions(
  compiled: PreparedPlanExecution,
): Promise<void> {
  const { context } = compiled;
  const isolatedSessions: Array<{
    readonly invocationId: string;
    readonly taskId: string;
  }> = [];
  for (const node of compiled.orderedNodes) {
    const invocationId = invocationIdForNode(context, node);
    if (node.type === "task" && node.execution !== "local") {
      const policy = node.session ?? { type: "isolated" as const };
      if (policy.type !== "isolated") {
        const task = context.taskDefinitions?.get(node.taskId);
        if (task === undefined) {
          throw new Error(`No task definition registered for "${node.taskId}"`);
        }
        const consumers = context.sessionConsumers.get(policy.from) ?? [];
        context.sessionConsumers.set(policy.from, [
          ...consumers,
          {
            invocationId,
            task,
            type: policy.type,
            effectiveSelection:
              context.effectiveModelSelections.get(invocationId),
          } satisfies SessionConsumer,
        ]);
        continue;
      }
      isolatedSessions.push({ invocationId, taskId: node.taskId });
    } else if (
      node.type === "validation.check" &&
      node.source.type === "task"
    ) {
      isolatedSessions.push({
        invocationId,
        taskId: node.source.taskId,
      });
    }
  }
  preflightCompiledWorkflowSessionCapabilities(compiled);
  for (const session of isolatedSessions) {
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      session.invocationId,
      session.taskId,
      context.effectiveModelSelections.get(session.invocationId),
    );
  }
  context.sharedSessionPairs = preflightSharedSessionOrder(compiled);
  rejectUnorderedSharedSessionPairs(context.sharedSessionPairs);
}
