import type {
  InvocationId,
  PlanNodeId,
  RepeatNode,
  ValidationCheckNode,
  ValidationGateNode,
} from "@seqlane/core";
import type { ObservabilityContext } from "@mastra/core/observability";
import { LoopLimitExceededError } from "@seqlane/core";
import { resolveBinding } from "../plan/binding-resolution.js";
import {
  invocationIdForNode,
  invocationCreationOrdinal,
  type ExecutionContext,
} from "../execution/context.js";
import {
  executeTaskNode,
  executeValidationCheckNode,
  executeValidationGateNode,
} from "./invocation-execution.js";
import {
  addBindingConsumers,
  consumeBindingReferences,
  releaseIfUnused,
  taskIdCompatibility,
  throwInvocationFailure,
} from "./invocation-support.js";
import { orderRepeatBodyNodes } from "../plan/plan-ordering.js";
import { summarizeSeqlaneOutput } from "../execution/output-summary.js";
import { toSeqlaneDisplayValue } from "../execution/display-value.js";
import {
  parseValidationResult,
  type RuntimeValidationResult,
} from "../validation/validation-results.js";
import {
  invocationKind,
  invocationSubject,
  invocationTaskId,
} from "../execution/workflow-run.js";
import { resolveTaskSession } from "../session/session-resolution.js";

function repeatBodyConsumers(node: RepeatNode): Map<string, number> {
  const remainingConsumers = new Map<string, number>();
  for (const bodyNode of node.body.nodes) {
    addBindingConsumers(remainingConsumers, bodyNode.input);
    if (bodyNode.type === "validation.gate") {
      remainingConsumers.set(
        bodyNode.checkNodeId,
        (remainingConsumers.get(bodyNode.checkNodeId) ?? 0) + 1,
      );
    }
  }
  addBindingConsumers(remainingConsumers, node.body.output);
  addBindingConsumers(remainingConsumers, node.body.until);
  return remainingConsumers;
}

export async function executeRepeatNode(
  context: ExecutionContext,
  node: RepeatNode,
  abortSignal: AbortSignal,
  observability: Partial<ObservabilityContext> = {},
): Promise<unknown> {
  const loopInvocationId = invocationIdForNode(context, node);
  context.events.emit({
    type: "invocation.started",
    workId: context.workId,
    runId: context.runId,
    invocationId: loopInvocationId,
    subject: { type: "task", taskId: node.nodeId },
    taskId: node.nodeId,
  });
  context.events.emit({
    type: "invocation.progress",
    workId: context.workId,
    runId: context.runId,
    invocationId: loopInvocationId,
    state: "active",
    phase: "repeat",
    message: "Executing loop",
  });
  context.events.emit({
    type: "invocation.output",
    workId: context.workId,
    runId: context.runId,
    invocationId: loopInvocationId,
    policy: "transient",
    channel: "task",
    content: "Executing loop",
  });

  try {
    let currentState = resolveBinding(
      node.input,
      context.workflowInput,
      context.results,
    );
    consumeBindingReferences(
      context.results,
      context.remainingConsumers,
      node.input,
    );
    const bodyNodes = orderRepeatBodyNodes(node);
    let latestValidation:
      Extract<RuntimeValidationResult, { success: false }> | undefined;

    for (
      let iteration = 1;
      iteration <= node.maximumIterations;
      iteration += 1
    ) {
      if (abortSignal.aborted) throw new Error("Repeat execution cancelled");
      const bodyResults = new Map<string, unknown>([
        [node.body.inputNodeId, currentState],
      ]);
      const bodyRemainingConsumers = repeatBodyConsumers(node);

      try {
        const bodyInvocationIds = new Map<PlanNodeId, InvocationId>();
        const bodyChecks = new Map<PlanNodeId, ValidationCheckNode>();
        for (const bodyNode of bodyNodes) {
          if (bodyNode.type === "validation.check") {
            bodyChecks.set(bodyNode.nodeId, bodyNode);
          }
        }
        for (const [bodyOrder, bodyNode] of bodyNodes.entries()) {
          const invocationId = context.createInvocationId(
            `${bodyNode.nodeId}:iteration:${iteration}`,
          );
          invocationCreationOrdinal(context, invocationId);
          bodyInvocationIds.set(bodyNode.nodeId, invocationId);
          const effectiveSelection = context.effectiveModelSelectionsByNode.get(
            bodyNode.nodeId,
          );
          if (bodyNode.type === "task" && bodyNode.execution !== "local") {
            await resolveTaskSession(
              context.resolvedSessions,
              context.sessionResolver,
              context.taskDefinitions,
              invocationId,
              bodyNode.taskId,
              effectiveSelection,
            );
          } else if (
            bodyNode.type === "validation.check" &&
            bodyNode.source.type === "task"
          ) {
            await resolveTaskSession(
              context.resolvedSessions,
              context.sessionResolver,
              context.taskDefinitions,
              invocationId,
              bodyNode.source.taskId,
              effectiveSelection,
            );
          }
          const subject = invocationSubject(bodyNode);
          context.events.emit({
            type: "invocation.created",
            workId: context.workId,
            runId: context.runId,
            invocationId,
            planNodeId: bodyNode.nodeId,
            subject,
            ...taskIdCompatibility(subject),
            kind: invocationKind(bodyNode),
            label: invocationTaskId(bodyNode),
            parentInvocationId: loopInvocationId,
            siblingOrder: (iteration - 1) * bodyNodes.length + bodyOrder,
            dependencyIds: bodyNode.dependsOn.flatMap((dependency) => {
              const dependencyId = bodyInvocationIds.get(dependency);
              return dependencyId === undefined ? [] : [dependencyId];
            }),
            iteration,
          });
          if (bodyNode.type === "task") {
            await executeTaskNode(context, bodyNode, abortSignal, {
              invocationId,
              observability,
              results: bodyResults,
              remainingConsumers: bodyRemainingConsumers,
              subject: { type: "task", taskId: bodyNode.taskId },
              iteration,
            });
          } else if (bodyNode.type === "validation.check") {
            await executeValidationCheckNode(context, bodyNode, abortSignal, {
              invocationId,
              observability,
              results: bodyResults,
              remainingConsumers: bodyRemainingConsumers,
              iteration,
            });
          } else {
            const checkNode = bodyChecks.get(bodyNode.checkNodeId);
            if (!checkNode) {
              throw new Error(
                `Validation gate "${bodyNode.nodeId}" has no body-local check`,
              );
            }
            await executeValidationGateNode(
              context,
              bodyNode,
              checkNode,
              abortSignal,
              {
                invocationId,
                observability,
                results: bodyResults,
                remainingConsumers: bodyRemainingConsumers,
                iteration,
              },
            );
          }
        }

        const nextState = resolveBinding(
          node.body.output,
          context.workflowInput,
          bodyResults,
        );
        consumeBindingReferences(
          bodyResults,
          bodyRemainingConsumers,
          node.body.output,
        );
        const postconditionGate = bodyNodes.find(
          (bodyNode): bodyNode is ValidationGateNode =>
            bodyNode.type === "validation.gate" &&
            bodyNode.policy === "repeat-postcondition",
        );
        const postconditionValidation = postconditionGate
          ? parseValidationResult(
              resolveBinding(
                {
                  type: "ref",
                  nodeId: postconditionGate.nodeId,
                  path: ["validation"],
                },
                context.workflowInput,
                bodyResults,
              ),
            )
          : undefined;
        const condition = resolveBinding(
          node.body.until,
          context.workflowInput,
          bodyResults,
        );
        consumeBindingReferences(
          bodyResults,
          bodyRemainingConsumers,
          node.body.until,
        );
        if (typeof condition !== "boolean") {
          throw new Error(
            `Repeat "${node.nodeId}" condition did not resolve to a boolean`,
          );
        }
        bodyResults.delete(node.body.inputNodeId);
        if (condition) {
          context.results.set(node.nodeId, nextState);
          context.events.emit({
            type: "invocation.result",
            workId: context.workId,
            runId: context.runId,
            invocationId: loopInvocationId,
            result: toSeqlaneDisplayValue(nextState, undefined),
          });
          context.events.emit({
            type: "invocation.succeeded",
            workId: context.workId,
            runId: context.runId,
            invocationId: loopInvocationId,
          });
          context.events.emit({
            type: "invocation.output",
            workId: context.workId,
            runId: context.runId,
            invocationId: loopInvocationId,
            policy: "persistent",
            channel: "task",
            content: "Loop completed",
            summary: summarizeSeqlaneOutput(nextState),
          });
          releaseIfUnused(
            context.results,
            context.remainingConsumers,
            node.nodeId,
          );
          return nextState;
        }
        if (postconditionValidation && !postconditionValidation.success) {
          latestValidation = postconditionValidation;
        }
        currentState = nextState;
      } finally {
        bodyResults.clear();
      }
    }

    throw new LoopLimitExceededError(
      node.nodeId,
      node.maximumIterations,
      latestValidation?.issues,
      latestValidation?.evidence,
    );
  } catch (cause) {
    throwInvocationFailure(cause, {
      context,
      abortSignal,
      invocationId: loopInvocationId,
      taskId: node.nodeId,
    });
  }
}
