import type { PreparedPlanExecution } from "../compile/compile-plan.js";
import { invocationIdForNode } from "../execution/context.js";
import type { AgentAdapterCapabilities } from "@seqlane/agent-adapter";
import type {
  InvocationId,
  ModelSelection,
  PlanNode,
  TaskNode,
} from "@seqlane/core";
import type { ExecutionContext } from "../execution/context.js";
import {
  materializeDeferredSessionConsumer,
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
    (policy.type === "isolated" || policy.type === "fork"
      ? policy.model
      : undefined) ?? effectiveSelection;
  if (explicitSelection !== undefined) {
    requireCapability(node.nodeId, capabilities, "modelSelection");
  }
  if (policy.type === "reuse") {
    requireCapability(node.nodeId, capabilities, "sessionReuse");
  }
  if (policy.type === "fork") {
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

/** Resolves a fresh session for one dynamic repeat attempt after input parsing. */
export async function resolveRepeatAttemptSession(
  context: ExecutionContext,
  node: TaskNode,
  invocationId: InvocationId,
): Promise<void> {
  const policy = node.session;
  if (policy === undefined) return;
  const effectiveSelection = context.effectiveModelSelectionsByNode.get(
    node.nodeId,
  );
  if (effectiveSelection !== undefined) {
    context.effectiveModelSelections.set(invocationId, effectiveSelection);
  }
  const task = context.taskDefinitions?.get(node.taskId);
  if (task === undefined) {
    throw new Error(`No task definition registered for "${node.taskId}"`);
  }
  if (policy.type === "isolated") {
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      invocationId,
      node.taskId,
      effectiveSelection,
    );
    return;
  }
  const consumer: SessionConsumer = {
    invocationId,
    task,
    type: policy.type,
    ...(effectiveSelection === undefined ? {} : { effectiveSelection }),
  };
  await materializeDeferredSessionConsumer({
    sourceNodeId: policy.from,
    source: context.deferredSessionSources.get(policy.from),
    consumer,
    resolvedSessions: context.resolvedSessions,
  });
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
  const sourceInvocations = new Map(
    compiled.orderedNodes.map((node) => [
      node.nodeId,
      invocationIdForNode(context, node),
    ]),
  );
  const isolatedSessions: Array<{
    readonly invocationId: string;
    readonly taskId: string;
  }> = [];
  for (const node of compiled.orderedNodes) {
    if (node.type === "repeat" && node.attempt.type === "task") {
      const policy = node.attempt.session;
      if (policy !== undefined && policy.type !== "isolated") {
        const task = context.taskDefinitions?.get(node.attempt.taskId);
        if (task === undefined) {
          throw new Error(
            `No task definition registered for "${node.attempt.taskId}"`,
          );
        }
        const consumers = context.sessionConsumers.get(policy.from) ?? [];
        context.sessionConsumers.set(policy.from, [
          ...consumers,
          {
            invocationId: `${context.runId}:${node.nodeId}:repeat-session-template`,
            task,
            type: policy.type,
            deferred: true,
            ...(context.effectiveModelSelectionsByNode.get(
              node.attempt.nodeId,
            ) === undefined
              ? {}
              : {
                  effectiveSelection:
                    context.effectiveModelSelectionsByNode.get(
                      node.attempt.nodeId,
                    ),
                }),
          } satisfies SessionConsumer,
        ]);
      }
      continue;
    }
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
        const sourceNodeId = arm.session.from;
        const sourceInvocationId = sourceInvocations.get(sourceNodeId);
        if (sourceInvocationId === undefined) {
          throw new Error(`No choice session source "${sourceNodeId}"`);
        }
        context.choiceSourceGate.register(sourceNodeId, sourceInvocationId);
        context.sessionConsumers.set(arm.session.from, [
          ...consumers,
          {
            invocationId,
            task,
            type: arm.session.type,
            deferred: true,
            effectiveSelection:
              arm.session.type === "fork" ? arm.session.model : undefined,
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
