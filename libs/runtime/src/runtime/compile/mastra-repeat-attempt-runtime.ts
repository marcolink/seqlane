import type { RequestContext } from "@mastra/core/request-context";
import type { ObservabilityContext } from "@mastra/core/observability";
import {
  MAX_REPEAT_BODY_EXECUTIONS,
  RunRepeatLimitExceededError,
} from "@seqlane/core";
import type { PlanNode, TaskNode, WorkflowNode } from "@seqlane/core";
import { resolveBinding } from "../plan/binding-resolution.js";
import {
  invocationKind as planInvocationKind,
  invocationSubject as planInvocationSubject,
  invocationTaskId as planInvocationTaskId,
} from "../execution/workflow-run.js";
import { taskIdCompatibility } from "../invocation/invocation-support.js";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";
import {
  repeatAttemptInvocationId,
  resolveMastraPlanRunContext,
} from "./mastra-run-context.js";
import {
  repeatEnvelopeFromInput,
  repeatScopedResults,
  type RepeatEnvelope,
} from "./mastra-repeat-envelope.js";
import type { RepeatCompilerDependencies } from "./mastra-repeat-compiler.js";

function attemptNodeFor(
  node: Extract<PlanNode, { type: "repeat" }>,
): TaskNode | WorkflowNode {
  return {
    ...node.attempt,
    input: {
      type: "ref",
      nodeId: `${node.nodeId}:attempt-input`,
      path: [],
    },
    dependsOn: [...node.attempt.dependsOn],
  };
}

function attemptDependencyIds(
  node: Extract<PlanNode, { type: "repeat" }>,
  dependencies: RepeatCompilerDependencies,
  runContext: ReturnType<typeof resolveMastraPlanRunContext>,
  invocationId: string,
  iteration: number,
): string[] {
  const dependencyIds = node.attempt.dependsOn.flatMap((dependency) => {
    const dependencyId = dependencies.invocationIdForNode(dependency);
    return dependencyId === undefined ? [] : [dependencyId];
  });
  if (iteration > 1) {
    dependencyIds.push(
      repeatAttemptInvocationId(runContext, invocationId, iteration - 1),
    );
  }
  return dependencyIds;
}

async function dispatchRepeatAttempt(options: {
  readonly node: Extract<PlanNode, { type: "repeat" }>;
  readonly attemptNode: TaskNode | WorkflowNode;
  readonly envelope: RepeatEnvelope;
  readonly runContext: ReturnType<typeof resolveMastraPlanRunContext>;
  readonly invocationId: string;
  readonly compilerOptions: MastraPlanCompilerOptions;
  readonly dependencies: RepeatCompilerDependencies;
  readonly abortSignal: AbortSignal;
  readonly observability: Partial<ObservabilityContext>;
}): Promise<unknown> {
  const {
    node,
    attemptNode,
    envelope,
    runContext,
    invocationId,
    compilerOptions,
    dependencies,
    abortSignal,
    observability,
  } = options;
  const invoke =
    attemptNode.type === "workflow"
      ? compilerOptions.executeWorkflowInvocation
      : compilerOptions.executeInvocation;
  if (invoke === undefined) {
    throw new Error(
      `No Mastra invocation handler is configured for repeat "${node.nodeId}"`,
    );
  }
  const attemptInvocationId = repeatAttemptInvocationId(
    runContext,
    invocationId,
    envelope.attemptNumber,
  );
  const subject = planInvocationSubject(attemptNode);
  runContext.events.emit({
    type: "invocation.created",
    workId: runContext.workId,
    runId: runContext.runId,
    invocationId: attemptInvocationId,
    planNodeId: attemptNode.nodeId,
    subject,
    ...taskIdCompatibility(subject),
    kind: planInvocationKind(attemptNode),
    label: planInvocationTaskId(attemptNode),
    parentInvocationId: invocationId,
    siblingOrder: envelope.attemptNumber - 1,
    dependencyIds: attemptDependencyIds(
      node,
      dependencies,
      runContext,
      invocationId,
      envelope.attemptNumber,
    ),
    iteration: envelope.attemptNumber,
  });
  return invoke({
    node: attemptNode,
    input: envelope.currentInput,
    workflowInput: envelope.workflowInput,
    workId: runContext.workId,
    runId: runContext.runId,
    invocationId: attemptInvocationId,
    ...(runContext.resourceId === undefined
      ? {}
      : { resourceId: runContext.resourceId }),
    workflowId: compilerOptions.workflowId ?? node.nodeId,
    abortSignal,
    requestContext: runContext.requestContext,
    observability,
    getStepResult: <Output = unknown>(nodeId: string): Output =>
      (nodeId === `${node.nodeId}:attempt-input`
        ? envelope.currentInput
        : envelope.dependencyResults.get(nodeId)) as Output,
    iteration: envelope.attemptNumber,
    repeatValidation: node.validation,
  });
}

export async function executeRepeatAttempt(options: {
  readonly inputData: unknown;
  readonly requestContext?: RequestContext;
  readonly abortSignal: AbortSignal;
  readonly observability: Partial<ObservabilityContext>;
  readonly node: Extract<PlanNode, { type: "repeat" }>;
  readonly invocationId: string;
  readonly compilerOptions: MastraPlanCompilerOptions;
  readonly dependencies: RepeatCompilerDependencies;
}): Promise<RepeatEnvelope> {
  const {
    node,
    invocationId,
    compilerOptions,
    dependencies,
    abortSignal,
    observability,
  } = options;
  const envelope = repeatEnvelopeFromInput(
    options.inputData,
    `${node.nodeId}:input`,
  );
  const runContext = resolveMastraPlanRunContext({
    ...envelope.runContext,
    requestContext: options.requestContext,
    repeatBudget: { executed: envelope.repeatExecutions },
  });
  runContext.repeatBudget.executed += 1;
  if (runContext.repeatBudget.executed > MAX_REPEAT_BODY_EXECUTIONS) {
    const error = new RunRepeatLimitExceededError(
      MAX_REPEAT_BODY_EXECUTIONS,
      runContext.repeatBudget.executed,
    );
    compilerOptions.onFailure?.(error);
    throw error;
  }
  const result = await dispatchRepeatAttempt({
    node,
    attemptNode: attemptNodeFor(node),
    envelope,
    runContext,
    invocationId,
    compilerOptions,
    dependencies,
    abortSignal,
    observability,
  });
  const scoped = repeatScopedResults(
    node,
    envelope.currentInput,
    result,
    envelope.dependencyResults,
  );
  const until = resolveBinding(node.until, envelope.workflowInput, scoped);
  if (typeof until !== "boolean") {
    throw new Error(
      `Repeat "${node.nodeId}" condition did not resolve to a boolean`,
    );
  }
  const nextInput =
    !until && node.nextInput !== undefined
      ? resolveBinding(node.nextInput, envelope.workflowInput, scoped)
      : envelope.initialInput;
  return {
    __seqlaneRepeatEnvelope: true,
    initialInput: envelope.initialInput,
    currentInput: nextInput,
    workflowInput: envelope.workflowInput,
    dependencyResults: envelope.dependencyResults,
    attemptNumber: envelope.attemptNumber + 1,
    result,
    until,
    runContext: envelope.runContext,
    repeatExecutions: runContext.repeatBudget.executed,
  };
}
