import type {
  InvocationId,
  PlanNode,
  RepeatNode,
  TaskNode,
  SeqlaneInvocationSubject,
  SeqlaneRunOutcome,
} from "@seqlane/core";
import {
  executeSequentialProgram,
  type SequentialProgramResult,
} from "./program.js";
import { invocationIdForNode, type ExecutionContext } from "./context.js";
import { toSeqlaneInvocationError } from "./errors.js";
import type { CompiledPlan } from "../compile/compile-plan.js";
import { taskIdCompatibility } from "../invocation/invocation-support.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

export interface ActiveWorkflowRun {
  readonly outcome: Promise<SeqlaneRunOutcome>;
  cancel(): Promise<void>;
}

export interface StartCompiledWorkflowOptions {
  readonly emitRunStarted?: boolean;
  readonly heartbeatIntervalMs?: number;
}

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
  if (node.type === "repeat") return node.nodeId;
  if (node.type === "validation.check") {
    return node.source.type === "task"
      ? node.source.taskId
      : node.source.validatorId;
  }
  return node.nodeId;
}

export function invocationSubject(node: PlanNode): SeqlaneInvocationSubject {
  if (node.type === "task" || node.type === "repeat") {
    return { type: "task", taskId: invocationTaskId(node) };
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
): "workflow" | "loop" | "task" | "validation" {
  if (node.type === "repeat") return "loop";
  if (node.type === "task") return "task";
  return "validation";
}

function emitInvocationTopology(
  context: ExecutionContext,
  orderedNodes: readonly PlanNode[],
): void {
  for (const [siblingOrder, node] of orderedNodes.entries()) {
    const subject = invocationSubject(node);
    context.events.emit({
      type: "invocation.created",
      workId: context.workId,
      runId: context.runId,
      invocationId: invocationIdForNode(context, node),
      planNodeId: node.nodeId,
      subject,
      ...taskIdCompatibility(subject),
      kind: invocationKind(node),
      label: invocationTaskId(node),
      siblingOrder,
      dependencyIds: availableDependencyIds(context, node),
    });
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

export function startCompiledWorkflow(
  compiled: CompiledPlan,
  options: StartCompiledWorkflowOptions = {},
): ActiveWorkflowRun {
  const { context } = compiled;
  const abortController = new AbortController();
  let execution: Promise<SequentialProgramResult> | undefined;
  let cancellationRequested = false;
  let finished = false;
  let cancellationPromise: Promise<void> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const startedAt = Date.now();

  const cancel = (): Promise<void> => {
    if (finished) return Promise.resolve();
    cancellationRequested = true;
    abortController.abort();
    cancellationPromise ??=
      execution?.then(() => undefined) ?? Promise.resolve();
    return cancellationPromise;
  };

  const outcome = (async (): Promise<SeqlaneRunOutcome> => {
    if (options.emitRunStarted ?? true) {
      context.events.emit({
        type: "run.started",
        workId: context.workId,
        runId: context.runId,
      });
    }
    emitInvocationTopology(context, compiled.orderedNodes);
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        context.events.emit({
          type: "run.heartbeat",
          workId: context.workId,
          runId: context.runId,
          activeInvocationIds: compiled.orderedNodes
            .filter(
              (node): node is TaskNode | RepeatNode =>
                node.type === "task" || node.type === "repeat",
            )
            .map((node) => invocationIdForNode(context, node)),
          elapsedMs: Date.now() - startedAt,
        });
      }, heartbeatIntervalMs);
    }

    const emitCancelled = (): SeqlaneRunOutcome => {
      finished = true;
      context.events.emit({
        type: "run.cancelled",
        workId: context.workId,
        runId: context.runId,
      });
      return { status: "cancelled" };
    };

    try {
      await Promise.resolve();
      if (cancellationRequested) {
        return emitCancelled();
      }

      execution = executeSequentialProgram(
        compiled.program,
        abortController.signal,
      );
      const result = await execution;

      if (cancellationRequested || result.status === "cancelled") {
        return emitCancelled();
      }

      if (result.status === "success") {
        const output = context.workflowResult;
        finished = true;
        context.events.emit({
          type: "run.succeeded",
          workId: context.workId,
          runId: context.runId,
          output,
        });
        return { status: "succeeded", result: output };
      }

      const error =
        context.failure ??
        toSeqlaneInvocationError(
          result.error,
          "runtime",
          compiled.plan.workflow.id,
        );
      context.failure = error;
      finished = true;
      context.events.emit({
        type: "run.failed",
        workId: context.workId,
        runId: context.runId,
        error,
      });
      return { status: "failed", error };
    } catch (cause) {
      if (cancellationRequested) return emitCancelled();

      const error =
        context.failure ??
        toSeqlaneInvocationError(cause, "runtime", compiled.plan.workflow.id);
      context.failure = error;
      finished = true;
      context.events.emit({
        type: "run.failed",
        workId: context.workId,
        runId: context.runId,
        error,
      });
      return { status: "failed", error };
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    }
  })();

  return { outcome, cancel };
}

export async function runCompiledWorkflow(
  compiled: CompiledPlan,
): Promise<SeqlaneRunOutcome> {
  return startCompiledWorkflow(compiled).outcome;
}
