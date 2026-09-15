import type { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
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
  assertRepeatWorkflowStateSize,
  initialRepeatStateValue,
  inlineRepeatStateValue,
  repeatScopedResults,
  repeatWorkflowStateSchema,
  type RepeatStateValue,
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
  readonly mastra?: Mastra;
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

async function resolveRepeatStateValue(
  value: RepeatStateValue,
  nodeId: string,
  mastra: Mastra | undefined,
): Promise<unknown> {
  if (value.kind === "inline") return value.value;
  if (mastra === undefined) {
    throw new Error(
      `Repeat "${nodeId}" cannot resolve Mastra snapshot state without storage`,
    );
  }
  const workflowStore = await mastra.getStorage()?.getStore("workflows");
  const snapshot =
    (await workflowStore?.loadWorkflowSnapshot({
      workflowName: value.workflowId,
      runId: value.runId,
    })) ?? null;
  if (snapshot === null) {
    throw new Error(
      `Repeat "${nodeId}" could not reload Mastra run "${value.runId}"`,
    );
  }
  if (value.path[0] === "input") {
    if (Object.hasOwn(snapshot.context, "input")) {
      return snapshot.context.input;
    }
  } else {
    const result = snapshot.context[value.path[1]];
    if (result?.status === "success") return result.output;
  }
  throw new Error(`Repeat "${nodeId}" has an invalid Mastra state reference`);
}

async function resolveRepeatState(options: {
  readonly state: RepeatWorkflowState;
  readonly node: Extract<PlanNode, { type: "repeat" }>;
  readonly dependencies: RepeatCompilerDependencies;
  readonly mastra?: Mastra;
}): Promise<{
  readonly initialInput: unknown;
  readonly currentInput: unknown;
  readonly workflowInput: unknown;
  readonly dependencyResults: Array<[string, unknown]>;
}> {
  const [workflowInput, dependencyResults] = await Promise.all([
    resolveRepeatStateValue(
      options.state.workflowInput,
      options.node.nodeId,
      options.mastra,
    ),
    Promise.all(
      options.state.dependencyResults.map(
        async ([nodeId, value]) =>
          [
            nodeId,
            await resolveRepeatStateValue(
              value,
              options.node.nodeId,
              options.mastra,
            ),
          ] as [string, unknown],
      ),
    ),
  ]);
  const dependencyResultMap = new Map(dependencyResults);
  const initialInput = options.dependencies.resolveStepInput(
    options.node,
    workflowInput,
    <Output = unknown>(nodeId: string): Output =>
      dependencyResultMap.get(nodeId) as Output,
  );
  const currentInput =
    options.state.currentInput.kind === "initial"
      ? initialInput
      : options.state.currentInput.value;
  return { initialInput, currentInput, workflowInput, dependencyResults };
}

async function persistRepeatAttemptState(options: {
  readonly node: Extract<PlanNode, { type: "repeat" }>;
  readonly state: RepeatWorkflowState;
  readonly resolvedState: Awaited<ReturnType<typeof resolveRepeatState>>;
  readonly result: unknown;
  readonly setState: (state: unknown) => Promise<void>;
}): Promise<boolean> {
  const scoped = repeatScopedResults(
    options.node,
    options.resolvedState.currentInput,
    options.result,
    options.resolvedState.dependencyResults,
  );
  const until = resolveBinding(
    options.node.until,
    options.resolvedState.workflowInput,
    scoped,
  );
  if (typeof until !== "boolean") {
    throw new Error(
      `Repeat "${options.node.nodeId}" condition did not resolve to a boolean`,
    );
  }
  const currentInput =
    !until && options.node.nextInput !== undefined
      ? inlineRepeatStateValue(
          resolveBinding(
            options.node.nextInput,
            options.resolvedState.workflowInput,
            scoped,
          ),
        )
      : initialRepeatStateValue();
  const nextState = repeatWorkflowStateSchema.parse({
    ...options.state,
    currentInput,
    result: inlineRepeatStateValue(options.result),
  });
  await options.setState(assertRepeatWorkflowStateSize(nextState));
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
  readonly mastra?: Mastra;
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
  const { envelope, state: persistedState } = loadRepeatAttemptState(options);
  const runContext = resolveMastraPlanRunContext({
    ...envelope.runContext,
    requestContext: options.requestContext,
    repeatBudget: { executed: envelope.repeatExecutions },
    mastra: options.mastra,
  });
  const state = await resolveRepeatState({
    state: persistedState,
    node,
    dependencies,
    mastra: runContext.mastra,
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
    state: persistedState,
    resolvedState: state,
    result,
    setState: options.setState,
  });
  return nextRepeatEnvelope(envelope, until, runContext.repeatBudget.executed);
}
