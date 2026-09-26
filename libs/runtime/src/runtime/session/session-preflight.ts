import type { PreparedPlanExecution } from "../compile/compile-plan.js";
import { invocationIdForNode } from "../execution/context.js";
import type { AgentAdapterCapabilities } from "@seqlane/agent-adapter";
import type { ModelSelection, PlanNode, TaskNode } from "@seqlane/core";
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

function agentTaskNodes(compiled: PreparedPlanExecution): readonly TaskNode[] {
  const nodes: TaskNode[] = [];
  const visit = (node: PlanNode): void => {
    if (node.type === "task") {
      if (node.session !== undefined) {
        nodes.push(node);
      }
      return;
    }
    if (node.type === "repeat") {
      visit(node.attempt);
      return;
    }
    // Choice arms are checked only after the condition selects one.
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
function checkTaskSessionCapabilities(
  node: TaskNode,
  capabilities: AgentAdapterCapabilities,
  effectiveSelection: ModelSelection | undefined,
): void {
  requireCapability(node.nodeId, capabilities, "execute");
  requireCapability(node.nodeId, capabilities, "structuredOutput");
  const policy = node.session ?? { type: "isolated" as const };
  const explicitSelection =
    (policy.type === "isolated" || policy.type === "branch"
      ? policy.model
      : undefined) ?? effectiveSelection;
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

export function preflightSelectedChoiceSessionCapabilities(
  context: PreparedPlanExecution["context"],
  node: TaskNode,
): void {
  const capabilities = context.sessionResolver?.adapterCapabilities;
  if (capabilities === undefined || node.session === undefined) return;
  checkTaskSessionCapabilities(
    node,
    capabilities,
    context.effectiveModelSelectionsByNode.get(node.nodeId),
  );
}

export function preflightCompiledWorkflowSessionCapabilities(
  compiled: PreparedPlanExecution,
): void {
  const capabilities = compiled.context.sessionResolver?.adapterCapabilities;
  if (capabilities === undefined) return;
  for (const node of agentTaskNodes(compiled)) {
    const invocationId =
      compiled.context.invocationIds.get(node.nodeId) ?? node.nodeId;
    checkTaskSessionCapabilities(
      node,
      capabilities,
      compiled.context.effectiveModelSelections.get(invocationId),
    );
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
    if (node.type === "choice") {
      for (const arm of [node.then, node.else]) {
        if (
          arm.type !== "task" ||
          arm.session === undefined ||
          arm.session.type === "isolated"
        ) {
          continue;
        }
        const invocationId = invocationIdForNode(context, arm);
        const task = context.taskDefinitions?.get(arm.taskId);
        if (task === undefined) {
          throw new Error(`No task definition registered for "${arm.taskId}"`);
        }
        const consumers = context.sessionConsumers.get(arm.session.from) ?? [];
        context.sessionConsumers.set(arm.session.from, [
          ...consumers,
          {
            invocationId,
            task,
            type: arm.session.type,
            deferred: true,
            effectiveSelection:
              arm.session.type === "branch" ? arm.session.model : undefined,
          } satisfies SessionConsumer,
        ]);
      }
      continue;
    }
    const invocationId = invocationIdForNode(context, node);
    if (node.type === "task" && node.session !== undefined) {
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
    }
  }
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
