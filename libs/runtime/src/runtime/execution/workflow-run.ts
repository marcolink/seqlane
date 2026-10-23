import type {
  InvocationId,
  PlanNode,
  SeqlaneInvocationSubject,
} from "@seqlane/core";
import { invocationIdForNode, type ExecutionContext } from "./context.js";
import { taskIdCompatibility } from "../invocation/invocation-support.js";

function availableDependencyIds(
  context: ExecutionContext,
  node: PlanNode,
): readonly InvocationId[] {
  return node.dependsOn.flatMap((dependency) => {
    const invocationId = context.invocationIds.get(dependency);
    return invocationId === undefined ? [] : [invocationId];
  });
}

export function invocationTaskId(node: PlanNode): string {
  if (node.type === "task") return node.taskId;
  if (node.type === "workflow") return node.workflowId;
  if (node.type === "repeat") return node.nodeId;
  if (node.type === "choice") return node.nodeId;
  if (node.type === "validation.check") {
    return node.source.type === "task"
      ? node.source.taskId
      : node.source.validatorId;
  }
  return node.nodeId;
}

export function invocationSubject(node: PlanNode): SeqlaneInvocationSubject {
  if (node.type === "workflow") {
    return { type: "workflow", workflowId: node.workflowId };
  }
  if (node.type === "task" || node.type === "repeat") {
    return { type: "task", taskId: invocationTaskId(node) };
  }
  if (node.type === "choice") {
    return { type: "choice", planNodeId: node.nodeId };
  }
  if (node.type === "validation.check") {
    return node.source.type === "task"
      ? { type: "task", taskId: node.source.taskId }
      : { type: "validator", validatorId: node.source.validatorId };
  }
  return { type: "validation-gate", planNodeId: node.nodeId };
}

export function invocationKind(
  node: PlanNode,
): "workflow" | "loop" | "choice" | "task" | "validation" {
  if (node.type === "repeat") return "loop";
  if (node.type === "choice") return "choice";
  if (node.type === "workflow") return "workflow";
  if (node.type === "task") return "task";
  return "validation";
}

export function emitInvocationTopology(
  context: ExecutionContext,
  orderedNodes: readonly PlanNode[],
): void {
  for (const [siblingOrder, node] of orderedNodes.entries()) {
    const subject = invocationSubject(node);
    const invocationId = invocationIdForNode(context, node);
    context.events.emit({
      type: "invocation.created",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      ...(context.parentInvocationId === undefined
        ? {}
        : { parentInvocationId: context.parentInvocationId }),
      planNodeId: node.nodeId,
      subject,
      ...taskIdCompatibility(subject),
      kind: invocationKind(node),
      label: invocationTaskId(node),
      siblingOrder,
      dependencyIds: availableDependencyIds(context, node),
    });
    if (node.type === "choice") {
      for (const [armOrder, arm] of [node.then, node.else].entries()) {
        const armSubject = invocationSubject(arm);
        const armInvocationId = context.invocationIds.get(arm.nodeId);
        if (armInvocationId === undefined) continue;
        context.events.emit({
          type: "invocation.created",
          workId: context.workId,
          runId: context.runId,
          invocationId: armInvocationId,
          planNodeId: arm.nodeId,
          subject: armSubject,
          ...taskIdCompatibility(armSubject),
          kind: invocationKind(arm),
          label: invocationTaskId(arm),
          parentInvocationId: invocationId,
          siblingOrder: armOrder,
          dependencyIds: availableDependencyIds(context, node),
        });
      }
    }
  }

  for (const node of orderedNodes) {
    if (node.dependsOn.length === 0) continue;
    context.events.emit({
      type: "invocation.progress",
      workId: context.workId,
      runId: context.runId,
      invocationId: invocationIdForNode(context, node),
      state: "waiting",
      phase: "dependencies",
      waitingReason: "Waiting for dependencies",
      dependencyIds: availableDependencyIds(context, node),
    });
  }
}

/** Close created choice arms when their enclosing node cannot execute them. */
export function settleUnstartedChoiceArms(
  context: ExecutionContext,
  node: PlanNode,
  outcome: "skipped" | "cancelled",
  dependencyIds: readonly InvocationId[] = [],
): void {
  if (node.type !== "choice") return;
  for (const arm of [node.then, node.else]) {
    const invocationId = invocationIdForNode(context, arm);
    if (context.terminalInvocationIds.has(invocationId)) continue;
    const identity = {
      workId: context.workId,
      runId: context.runId,
      invocationId,
    };
    context.events.emit(
      outcome === "cancelled"
        ? {
            type: "invocation.cancelled",
            ...identity,
            reason: "Choice cancelled before arm execution",
          }
        : {
            type: "invocation.skipped",
            ...identity,
            reason: "Choice failed before arm execution",
            dependencyIds,
          },
    );
  }
}
