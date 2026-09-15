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
  assertRepeatEnvelopeSize,
  repeatScopedResults,
  repeatWorkflowStateSchema,
  type RepeatWorkflowState,
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
  readonly currentInput: unknown;
  readonly workflowInput: unknown;
  readonly dependencyResults: ReadonlyArray<readonly [string, unknown]>;
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
    currentInput,
    workflowInput,
    dependencyResults,
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
  const dependencyResultMap = new Map(dependencyResults);
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
    input: currentInput,
    workflowInput,
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
        ? currentInput
        : dependencyResultMap.get(nodeId)) as Output,
    iteration: envelope.attemptNumber,
    repeatValidation: node.validation,
  });
}

function loadRepeatAttemptState(options: {
  readonly inputData: unknown;
  readonly state: unknown;
  readonly workflowId: string;
  readonly runId: string;
  readonly node: Extract<PlanNode, { type: "repeat" }>;
}): { envelope: RepeatEnvelope; state: RepeatWorkflowState } {
  const envelope = repeatEnvelopeFromInput(
    options.inputData,
    `${options.node.nodeId}:input`,
  );
  const stateResult = repeatWorkflowStateSchema.safeParse(options.state);
  if (!stateResult.success) {
    throw new Error(
      `Repeat "${options.node.nodeId}" has invalid durable state`,
    );
  }
  if (
    envelope.stateRef.workflowId !== options.workflowId ||
    envelope.stateRef.runId !== options.runId
  ) {
    throw new Error(
      `Repeat "${options.node.nodeId}" resumed under the wrong Mastra run`,
    );
  }
  return { envelope, state: stateResult.data };
}

async function persistRepeatAttemptState(options: {
  readonly node: Extract<PlanNode, { type: "repeat" }>;
  readonly state: RepeatWorkflowState;
  readonly result: unknown;
  readonly setState: (state: unknown) => Promise<void>;
}): Promise<boolean> {
  const scoped = repeatScopedResults(
    options.node,
    options.state.currentInput,
    options.result,
    options.state.dependencyResults,
  );
  const until = resolveBinding(
    options.node.until,
    options.state.workflowInput,
    scoped,
  );
  if (typeof until !== "boolean") {
    throw new Error(
      `Repeat "${options.node.nodeId}" condition did not resolve to a boolean`,
    );
  }
  const nextInput =
    !until && options.node.nextInput !== undefined
      ? resolveBinding(
          options.node.nextInput,
          options.state.workflowInput,
          scoped,
        )
      : options.state.initialInput;
  await options.setState({
    ...options.state,
    currentInput: nextInput,
    result: options.result,
  });
  return until;
}

function nextRepeatEnvelope(
  envelope: RepeatEnvelope,
  until: boolean,
  repeatExecutions: number,
): RepeatEnvelope {
  return assertRepeatEnvelopeSize({
    __seqlaneRepeatEnvelope: true,
    stateRef: envelope.stateRef,
    attemptNumber: envelope.attemptNumber + 1,
    until,
    runContext: envelope.runContext,
    repeatExecutions,
  });
}

export async function executeRepeatAttempt(options: {
  readonly inputData: unknown;
  readonly state: unknown;
  readonly setState: (state: unknown) => Promise<void>;
  readonly workflowId: string;
  readonly runId: string;
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
  const { envelope, state } = loadRepeatAttemptState(options);
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
    currentInput: state.currentInput,
    workflowInput: state.workflowInput,
    dependencyResults: state.dependencyResults,
    runContext,
    invocationId,
    compilerOptions,
    dependencies,
    abortSignal,
    observability,
  });
  const until = await persistRepeatAttemptState({
    node,
    state,
    result,
    setState: options.setState,
  });
  return nextRepeatEnvelope(envelope, until, runContext.repeatBudget.executed);
}
