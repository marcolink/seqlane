import type {
  InvocationId,
  PlanNode,
  RepeatNode,
  SeqlaneEventSink,
  ValidationCheckNode,
  ValidationGateNode,
} from "@seqlane/core";
import type { ObservabilityContext } from "@mastra/core/observability";
import type { PreparedPlanExecution } from "../compile/compile-plan.js";
import {
  executeValidationCheckNode,
  executeValidationGateNode,
} from "../invocation/invocation-execution.js";
import {
  invocationKind,
  invocationSubject,
  invocationTaskId,
} from "../execution/workflow-run.js";
import { taskIdCompatibility } from "../invocation/invocation-support.js";

interface RepeatValidationNodes {
  readonly inputNodeId: string;
  readonly check: ValidationCheckNode;
  readonly gate: ValidationGateNode;
}

interface RepeatValidationOptions {
  readonly invocationId: InvocationId;
  readonly observability: Partial<ObservabilityContext>;
  readonly iteration?: number;
}

function createValidationNodes(
  attempt: PlanNode,
  validation: RepeatNode["validation"],
  iteration?: number,
): RepeatValidationNodes {
  if (validation === undefined) {
    throw new Error("Output validation is not configured");
  }
  const suffix = iteration ?? "choice";
  const inputNodeId = `${attempt.nodeId}:validation-input:${suffix}`;
  const checkNodeId = `${attempt.nodeId}:validation.check:${suffix}`;
  const input = { type: "ref" as const, nodeId: inputNodeId, path: [] };
  return {
    inputNodeId,
    check: {
      type: "validation.check",
      nodeId: checkNodeId,
      source: validation.source,
      input,
      dependsOn: [],
    },
    gate: {
      type: "validation.gate",
      nodeId: `${attempt.nodeId}:validation.gate:${suffix}`,
      input,
      checkNodeId,
      policy: "fail",
      dependsOn: [checkNodeId],
    },
  };
}

function emitCreated(
  events: SeqlaneEventSink,
  context: PreparedPlanExecution["context"],
  node: ValidationCheckNode | ValidationGateNode,
  invocationId: InvocationId,
  parentInvocationId: InvocationId,
  siblingOrder: number,
  dependencyIds: readonly InvocationId[],
  iteration?: number,
): void {
  const subject = invocationSubject(node);
  events.emit({
    type: "invocation.created",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    planNodeId: node.nodeId,
    subject,
    ...taskIdCompatibility(subject),
    kind: invocationKind(node),
    label: invocationTaskId(node),
    parentInvocationId,
    siblingOrder,
    dependencyIds,
    ...(iteration === undefined ? {} : { iteration }),
  });
}

function emitGateTerminal(
  events: SeqlaneEventSink,
  context: PreparedPlanExecution["context"],
  invocationId: InvocationId,
  checkInvocationId: InvocationId,
  iteration: number | undefined,
  aborted: boolean,
): void {
  if (aborted) {
    events.emit({
      type: "invocation.cancelled",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      reason: "Validation check cancelled before gate execution",
      ...(iteration === undefined ? {} : { iteration }),
    });
    return;
  }
  events.emit({
    type: "invocation.skipped",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    reason: "Validation check failed before gate execution",
    dependencyIds: [checkInvocationId],
    ...(iteration === undefined ? {} : { iteration }),
  });
}

export async function validateRepeatOutput(
  context: PreparedPlanExecution["context"],
  attempt: PlanNode,
  output: unknown,
  validation: RepeatNode["validation"],
  abortSignal: AbortSignal,
  options: RepeatValidationOptions,
): Promise<void> {
  if (validation === undefined) return;
  const nodes = createValidationNodes(attempt, validation, options.iteration);
  const results = context.results;
  const remainingConsumers = context.remainingConsumers;
  results.set(nodes.inputNodeId, output);
  remainingConsumers.set(nodes.inputNodeId, 2);
  remainingConsumers.set(nodes.check.nodeId, 1);

  const checkInvocationId = `${options.invocationId}:validation:check`;
  const gateInvocationId = `${options.invocationId}:validation:gate`;
  emitCreated(
    context.events,
    context,
    nodes.check,
    checkInvocationId,
    options.invocationId,
    0,
    [],
    options.iteration,
  );
  emitCreated(
    context.events,
    context,
    nodes.gate,
    gateInvocationId,
    options.invocationId,
    1,
    [checkInvocationId],
    options.iteration,
  );
  try {
    await executeValidationCheckNode(context, nodes.check, abortSignal, {
      invocationId: checkInvocationId,
      observability: options.observability,
      results,
      remainingConsumers,
      iteration: options.iteration,
    });
  } catch (cause) {
    emitGateTerminal(
      context.events,
      context,
      gateInvocationId,
      checkInvocationId,
      options.iteration,
      abortSignal.aborted,
    );
    throw cause;
  }
  await executeValidationGateNode(
    context,
    nodes.gate,
    nodes.check,
    abortSignal,
    {
      invocationId: gateInvocationId,
      observability: options.observability,
      results,
      remainingConsumers,
      iteration: options.iteration,
    },
  );
}
