import { Effect, Exit } from "effect";
import type { TaskNode } from "@seqlane/core";
import {
  invocationCreationOrdinal,
  type ExecutionContext,
} from "../execution/context.js";
import { getTaskSchema } from "../plan/task-schema.js";
import { executeTaskNode, prepareTaskInput } from "./invocation-execution.js";
import {
  optionalIteration,
  type TaskExecutionOptions,
} from "./invocation-support.js";
import type { PreparedInvocationInput } from "./prepared-input.js";

/** Acquire joint eligibility before taking a bounded task-body permit. */
export function executeTaskNodeEffect(
  context: ExecutionContext,
  node: TaskNode,
  abortSignal: AbortSignal,
  options: TaskExecutionOptions,
  withBodyPermit: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
): Effect.Effect<unknown, unknown> {
  const invocationId = options.invocationId;
  const creationOrdinal = invocationCreationOrdinal(context, invocationId);
  const resource = context.workspaceResources.get(node.taskId) ?? {
    key: "seqlane:runtime-workspace",
  };
  const session = context.resolvedSessions.get(invocationId);
  let workspaceWaitingReported = false;
  let sessionWaitingReported = false;
  const request = {
    signal: abortSignal,
    session,
    workspace: resource,
    workspacePolicy: node.workspace,
    invocationId,
    ownerId: context.workspaceOwnerId ?? invocationId,
    creationOrdinal,
    onWorkspaceWaiting: (blockingInvocationId: string | undefined) => {
      if (workspaceWaitingReported) return;
      workspaceWaitingReported = true;
      context.events.emit({
        type: "invocation.progress",
        workId: context.workId,
        runId: context.runId,
        invocationId,
        state: "waiting",
        phase: "admission",
        waitingReason: "workspace_unavailable",
        workspace: node.workspace,
        ...(blockingInvocationId === undefined ? {} : { blockingInvocationId }),
        ...optionalIteration(options.iteration),
      });
    },
    onSessionWaiting: () => {
      if (sessionWaitingReported) return;
      sessionWaitingReported = true;
      context.events.emit({
        type: "invocation.progress",
        workId: context.workId,
        runId: context.runId,
        invocationId,
        state: "waiting",
        phase: "admission",
        waitingReason: "session_unavailable",
        ...optionalIteration(options.iteration),
      });
    },
  };
  const taskSchema = getTaskSchema(
    context.taskSchemas,
    node.taskId,
    context.taskDefinitions,
  );
  let preparedInput: PreparedInvocationInput;
  try {
    preparedInput = prepareTaskInput(
      context,
      node,
      options,
      abortSignal,
      taskSchema.input,
    );
  } catch (cause) {
    return Effect.fail(cause);
  }
  const ownership: { retain: boolean; uncertainty?: unknown } = {
    retain: false,
  };
  return Effect.scoped(
    Effect.gen(function* () {
      const admission = yield* Effect.acquireRelease(
        context.jointAdmissions.acquireEffect(request),
        (lease) =>
          Effect.sync(() => {
            if (ownership.retain) return;
            lease.sessionLease?.release();
            lease.workspaceLease.release();
          }),
        { interruptible: true },
      );
      return yield* withBodyPermit(
        Effect.suspend(() => {
          if (abortSignal.aborted)
            return Effect.fail(
              abortSignal.reason ?? new Error("Task execution cancelled"),
            );
          let pending: Promise<unknown> | undefined;
          const execution = Effect.tryPromise({
            try: (fiberSignal) => {
              pending = executeTaskNode(
                context,
                node,
                AbortSignal.any([abortSignal, fiberSignal]),
                {
                  ...options,
                  preparedInput,
                  admission,
                  admissionOwnership: ownership,
                },
              );
              return pending;
            },
            catch: (cause) => cause,
          });
          return Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(Effect.exit(restore(execution)), (exit) =>
              Effect.promise(
                () =>
                  pending?.then(
                    () => undefined,
                    () => undefined,
                  ) ?? Promise.resolve(),
              ).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    ownership.uncertainty !== undefined
                      ? Effect.fail(ownership.uncertainty)
                      : Exit.isSuccess(exit)
                        ? Effect.succeed(exit.value)
                        : Effect.failCause(exit.cause),
                  ),
                ),
              ),
            ),
          );
        }),
      );
    }),
  );
}
