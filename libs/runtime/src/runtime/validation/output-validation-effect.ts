import { Effect } from "effect";
import type {
  InvocationId,
  OutputValidation,
  PlanNode,
  TaskNode,
  ValidationCheckNode,
  ValidationGateNode,
} from "@seqlane/core";
import type { ExecutionContext } from "../execution/context.js";
import {
  invocationKind,
  invocationSubject,
  invocationTaskId,
} from "../execution/workflow-run.js";
import {
  optionalIteration,
  taskIdCompatibility,
} from "../invocation/invocation-support.js";
import {
  executeValidationCheckNode,
  executeValidationGateNode,
} from "../invocation/invocation-execution.js";
import { executeTaskNodeEffect } from "../invocation/task-admission.js";
import { parseValidationResult } from "./validation-results.js";

function validationNodes(
  attempt: PlanNode,
  validation: OutputValidation,
  iteration?: number,
): {
  inputNodeId: string;
  check: ValidationCheckNode;
  gate: ValidationGateNode;
} {
  const suffix = iteration ?? "choice";
  const inputNodeId = `${attempt.nodeId}:validation-input:${suffix}`;
  const input = { type: "ref" as const, nodeId: inputNodeId, path: [] };
  return {
    inputNodeId,
    check: {
      type: "validation.check",
      nodeId: `${attempt.nodeId}:validation.check:${suffix}`,
      source: validation.source,
      input,
      dependsOn: [],
    },
    gate: {
      type: "validation.gate",
      nodeId: `${attempt.nodeId}:validation.gate:${suffix}`,
      input,
      checkNodeId: `${attempt.nodeId}:validation.check:${suffix}`,
      policy: "fail",
      dependsOn: [`${attempt.nodeId}:validation.check:${suffix}`],
    },
  };
}

function emitCreated(
  context: ExecutionContext,
  node: ValidationCheckNode | ValidationGateNode,
  invocationId: InvocationId,
  parentInvocationId: InvocationId,
  siblingOrder: number,
  dependencyIds: readonly InvocationId[],
  iteration?: number,
): void {
  const subject = invocationSubject(node);
  context.events.emit({
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
    ...optionalIteration(iteration),
  });
}

export function validateRunnableOutputEffect(
  context: ExecutionContext,
  attempt: PlanNode,
  output: unknown,
  validation: OutputValidation | undefined,
  abortSignal: AbortSignal,
  options: {
    readonly invocationId: InvocationId;
    readonly iteration?: number;
    readonly withBodyPermit: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
  },
): Effect.Effect<void, unknown> {
  if (validation === undefined) return Effect.void;
  return Effect.gen(function* () {
    const nodes = validationNodes(attempt, validation, options.iteration);
    context.results.set(nodes.inputNodeId, output);
    context.remainingConsumers.set(nodes.inputNodeId, 2);
    context.remainingConsumers.set(nodes.check.nodeId, 1);
    const checkInvocationId = `${options.invocationId}:validation:check`;
    const gateInvocationId = `${options.invocationId}:validation:gate`;
    emitCreated(
      context,
      nodes.check,
      checkInvocationId,
      options.invocationId,
      0,
      [],
      options.iteration,
    );
    emitCreated(
      context,
      nodes.gate,
      gateInvocationId,
      options.invocationId,
      1,
      [checkInvocationId],
      options.iteration,
    );

    const source = nodes.check.source;
    const checkEffect =
      source.type === "task"
        ? executeTaskNodeEffect(
            context,
            {
              type: "task",
              taskId: source.taskId,
              nodeId: nodes.check.nodeId,
              workspace: source.workspace,
              input: nodes.check.input,
              dependsOn: nodes.check.dependsOn,
            } satisfies TaskNode,
            abortSignal,
            {
              invocationId: checkInvocationId,
              results: context.results,
              remainingConsumers: context.remainingConsumers,
              subject: { type: "task", taskId: source.taskId },
              iteration: options.iteration,
              validateOutput: parseValidationResult,
            },
            options.withBodyPermit,
          )
        : options.withBodyPermit(
            Effect.tryPromise({
              try: () =>
                executeValidationCheckNode(context, nodes.check, abortSignal, {
                  invocationId: checkInvocationId,
                  results: context.results,
                  remainingConsumers: context.remainingConsumers,
                  iteration: options.iteration,
                }),
              catch: (cause) => cause,
            }),
          );
    yield* Effect.catch(checkEffect, (cause) =>
      Effect.sync(() => {
        context.events.emit({
          type: abortSignal.aborted
            ? "invocation.cancelled"
            : "invocation.skipped",
          workId: context.workId,
          runId: context.runId,
          invocationId: gateInvocationId,
          ...(abortSignal.aborted
            ? { reason: "Validation check cancelled before gate execution" }
            : {
                reason: "Validation check failed before gate execution",
                dependencyIds: [checkInvocationId],
              }),
          ...optionalIteration(options.iteration),
        });
      }).pipe(Effect.andThen(Effect.fail(cause))),
    );

    yield* options.withBodyPermit(
      Effect.tryPromise({
        try: () =>
          executeValidationGateNode(
            context,
            nodes.gate,
            nodes.check,
            abortSignal,
            {
              invocationId: gateInvocationId,
              results: context.results,
              remainingConsumers: context.remainingConsumers,
              iteration: options.iteration,
            },
          ),
        catch: (cause) => cause,
      }),
    );
  });
}
