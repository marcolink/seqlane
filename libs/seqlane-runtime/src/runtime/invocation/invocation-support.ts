import type {
  InvocationId,
  PlanNode,
  SeqlaneInvocationSubject,
  TaskNode,
  ValueBinding,
} from "@seqlane/core";
import {
  referencedNodeIds,
  WORKFLOW_INPUT_NODE_ID,
} from "../plan/binding-resolution.js";
import type { ExecutionContext } from "../execution/context.js";
import { toSeqlaneInvocationError } from "../execution/errors.js";
import type { RuntimeValidationResult } from "../validation/validation-results.js";

export type LegacyTaskNode = PlanNode & { readonly executor?: string };

export interface TaskExecutionOptions {
  readonly invocationId: InvocationId;
  readonly results: Map<string, unknown>;
  readonly remainingConsumers: Map<string, number>;
  readonly subject: SeqlaneInvocationSubject;
  /** `graph` means static workspace conflicts are already dependency edges. */
  readonly workspaceAdmission?: "dynamic" | "graph";
  readonly iteration?: number;
  readonly validateOutput?: (output: unknown) => unknown;
}

export interface ValidationExecutionOptions {
  readonly invocationId: InvocationId;
  readonly results: Map<string, unknown>;
  readonly remainingConsumers: Map<string, number>;
  /** `graph` means static workspace conflicts are already dependency edges. */
  readonly workspaceAdmission?: "dynamic" | "graph";
  readonly iteration?: number;
}

export interface ValidationEnvelope {
  readonly value: unknown;
  readonly validation: RuntimeValidationResult;
}

export function taskIdCompatibility(
  subject: SeqlaneInvocationSubject,
): { readonly taskId: string } | Record<string, never> {
  return subject.type === "task" ? { taskId: subject.taskId } : {};
}

export function addBindingConsumers(
  remainingConsumers: Map<string, number>,
  binding: ValueBinding,
): void {
  for (const nodeId of referencedNodeIds(binding)) {
    if (nodeId === WORKFLOW_INPUT_NODE_ID) continue;
    remainingConsumers.set(nodeId, (remainingConsumers.get(nodeId) ?? 0) + 1);
  }
}

export function optionalIteration(
  iteration: number | undefined,
): { readonly iteration: number } | Record<string, never> {
  return iteration === undefined ? {} : { iteration };
}

export function consumeNodeReference(
  results: Map<string, unknown>,
  remainingConsumers: Map<string, number>,
  nodeId: string,
): void {
  const remaining = remainingConsumers.get(nodeId);
  if (remaining === undefined || remaining === 0) return;
  const nextRemaining = remaining - 1;
  remainingConsumers.set(nodeId, nextRemaining);
  if (nextRemaining === 0) results.delete(nodeId);
}

export function consumeBindingReferences(
  results: Map<string, unknown>,
  remainingConsumers: Map<string, number>,
  binding: ValueBinding,
): void {
  for (const nodeId of referencedNodeIds(binding)) {
    if (nodeId === WORKFLOW_INPUT_NODE_ID) continue;
    consumeNodeReference(results, remainingConsumers, nodeId);
  }
}

export function releaseIfUnused(
  results: Map<string, unknown>,
  remainingConsumers: ReadonlyMap<string, number>,
  nodeId: string,
): void {
  if ((remainingConsumers.get(nodeId) ?? 0) === 0) results.delete(nodeId);
}

export function throwTaskPhaseError(
  cause: unknown,
  phase: "input" | "executor" | "output",
  taskId: TaskNode["taskId"],
  abortSignal: AbortSignal,
): never {
  if (phase === "executor" && abortSignal.aborted) throw cause;
  throw toSeqlaneInvocationError(cause, phase, taskId);
}

interface InvocationFailureOptions {
  readonly context: ExecutionContext;
  readonly abortSignal: AbortSignal;
  readonly invocationId: InvocationId;
  readonly taskId: TaskNode["taskId"];
  readonly iteration?: number;
}

export function throwInvocationFailure(
  cause: unknown,
  options: InvocationFailureOptions,
): never {
  const { context, abortSignal, invocationId, taskId, iteration } = options;
  if (abortSignal.aborted) throw cause;

  const error = toSeqlaneInvocationError(cause, "runtime", taskId);
  context.failure = error;
  context.events.emit({
    type: "invocation.failed",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    error,
    disposition: "fail_run",
    ...optionalIteration(iteration),
  });
  throw error;
}
