import { Effect } from "effect";
import type { PlanNode, ValidationCheckNode } from "@seqlane/core";
import {
  invocationIdForNode,
  type ExecutionContext,
} from "../execution/context.js";
import { findUnconfirmedInvocationTermination } from "../execution/executor.js";
import { toSeqlaneInvocationError } from "../execution/errors.js";
import type { SequentialProgramStep } from "../execution/program.js";
import {
  executeTaskNode,
  executeValidationCheckNode,
  executeValidationGateNode,
} from "../invocation/invocation-execution.js";
import { executeTaskNodeEffect } from "../invocation/task-admission.js";
import { parseValidationResult } from "../validation/validation-results.js";

/** Build one Plan node step with its execution and invocation terminal policy. */
export function createCompiledNodeStep(
  context: ExecutionContext,
  node: PlanNode,
  checkNodes: ReadonlyMap<string, ValidationCheckNode>,
  terminalInvocationIds: ReadonlySet<string>,
): SequentialProgramStep {
  return {
    id: node.nodeId,
    dependsOn: node.dependsOn,
    execute: async ({ abortSignal }) => {
      try {
        await executeNode(context, node, checkNodes, abortSignal);
        return { nodeId: node.nodeId };
      } catch (cause) {
        emitFailureTerminal(
          context,
          node,
          cause,
          abortSignal,
          terminalInvocationIds,
        );
        throw cause;
      }
    },
    executeEffect: ({ abortSignal, withBodyPermit }) => {
      let effect: Effect.Effect<unknown, unknown>;
      if (node.type === "task") {
        effect = executeTaskNodeEffect(
          context,
          node,
          abortSignal,
          {
            invocationId: invocationIdForNode(context, node),
            observability: {},
            results: context.results,
            remainingConsumers: context.remainingConsumers,
            subject: { type: "task", taskId: node.taskId },
          },
          withBodyPermit,
        );
      } else if (
        node.type === "validation.check" &&
        node.source.type === "task"
      ) {
        const taskNode = {
          type: "task",
          taskId: node.source.taskId,
          nodeId: node.nodeId,
          workspace: node.source.workspace,
          input: node.input,
          dependsOn: node.dependsOn,
        } as const;
        effect = executeTaskNodeEffect(
          context,
          taskNode,
          abortSignal,
          {
            invocationId: invocationIdForNode(context, node),
            observability: {},
            results: context.results,
            remainingConsumers: context.remainingConsumers,
            subject: { type: "task", taskId: node.source.taskId },
            validateOutput: parseValidationResult,
          },
          withBodyPermit,
        );
      } else {
        effect = withBodyPermit(
          Effect.tryPromise({
            try: () => executeNode(context, node, checkNodes, abortSignal),
            catch: (cause) => cause,
          }),
        );
      }
      return Effect.catch(effect, (cause) =>
        Effect.sync(() => {
          emitFailureTerminal(
            context,
            node,
            cause,
            abortSignal,
            terminalInvocationIds,
          );
        }).pipe(Effect.andThen(Effect.fail(cause))),
      );
    },
    onSkip: (failedDependencyIds) => {
      context.events.emit({
        type: "invocation.skipped",
        workId: context.workId,
        runId: context.runId,
        invocationId: invocationIdForNode(context, node),
        reason: "dependency failed",
        dependencyIds: failedDependencyIds.flatMap((id) => {
          const invocationId = context.invocationIds.get(id);
          return invocationId === undefined ? [] : [invocationId];
        }),
      });
    },
    onCancel: () => {
      context.events.emit({
        type: "invocation.cancelled",
        workId: context.workId,
        runId: context.runId,
        invocationId: invocationIdForNode(context, node),
        reason: "Run cancelled before invocation execution",
      });
    },
  };
}

async function executeNode(
  context: ExecutionContext,
  node: PlanNode,
  checkNodes: ReadonlyMap<string, ValidationCheckNode>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (node.type === "repeat" || node.type === "choice") {
    throw new Error(
      `Sequential Plan compiler does not support ${node.type} node "${node.nodeId}"`,
    );
  }
  if (node.type === "task") {
    await executeTaskNode(context, node, abortSignal, {
      invocationId: invocationIdForNode(context, node),
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: node.taskId },
      workspaceAdmission: "graph",
    });
  } else if (node.type === "workflow") {
    throw new Error(
      `Sequential Plan compiler does not support workflow node "${node.nodeId}"`,
    );
  } else if (node.type === "validation.check") {
    await executeValidationCheckNode(context, node, abortSignal, {
      invocationId: invocationIdForNode(context, node),
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      workspaceAdmission: "graph",
    });
  } else {
    const checkNode = checkNodes.get(node.checkNodeId);
    if (checkNode === undefined) {
      throw new Error(`Validation gate "${node.nodeId}" has no check node`);
    }
    await executeValidationGateNode(context, node, checkNode, abortSignal, {
      invocationId: invocationIdForNode(context, node),
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
    });
  }
}

function emitFailureTerminal(
  context: ExecutionContext,
  node: PlanNode,
  cause: unknown,
  abortSignal: AbortSignal,
  terminalInvocationIds: ReadonlySet<string>,
): void {
  const invocationId = invocationIdForNode(context, node);
  if (terminalInvocationIds.has(invocationId)) return;
  if (
    abortSignal.aborted &&
    findUnconfirmedInvocationTermination(cause) === undefined
  ) {
    context.events.emit({
      type: "invocation.cancelled",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      reason: "Run cancelled during invocation execution",
    });
    return;
  }
  const taskId = node.type === "task" ? node.taskId : node.nodeId;
  const error = toSeqlaneInvocationError(cause, "runtime", taskId);
  context.failure = error;
  context.events.emit({
    type: "invocation.failed",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    error,
    disposition: "fail_run",
  });
}
