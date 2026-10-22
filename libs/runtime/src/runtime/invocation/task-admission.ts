import { Cause, Effect, Exit, Option, Tracer } from "effect";
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
import {
  findUnconfirmedInvocationTermination,
  UnconfirmedInvocationTerminationError,
} from "../execution/executor.js";

const OWNED_CLEANUP_TIMEOUT_MS = 30_000;

export function settleOwnedPromise<A>(
  run: () => Promise<A>,
  timeoutMs = OWNED_CLEANUP_TIMEOUT_MS,
  onUnconfirmed?: (error: UnconfirmedInvocationTerminationError) => void,
): Effect.Effect<A, unknown> {
  let pending: Promise<A> | undefined;
  const operation = Effect.tryPromise({
    try: () => (pending = run()),
    catch: (cause) => cause,
  });
  return Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.exit(restore(operation)), (exit) => {
      return Effect.flatMap(
        Effect.promise(
          () =>
            pending?.then(
              () => undefined,
              () => undefined,
            ) ?? Promise.resolve(),
        ).pipe(Effect.timeoutOption(timeoutMs)),
        (settled) => {
          if (Option.isNone(settled)) {
            const error = new UnconfirmedInvocationTerminationError("timeout");
            onUnconfirmed?.(error);
            observeLateFailure(pending, error);
            return Effect.fail(error);
          }
          return Effect.suspend(() =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : Effect.failCause(exit.cause),
          );
        },
      );
    }),
  );
}

/**
 * Acquire joint eligibility before taking a bounded task-body permit.
 * Task callbacks and checkpoint hooks remain owned Promise integration edges.
 */
export function executeTaskNodeEffect(
  context: ExecutionContext,
  node: TaskNode,
  abortSignal: AbortSignal,
  options: TaskExecutionOptions,
  withBodyPermit: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  afterBody?: (
    output: unknown,
    onUnconfirmed: (error: UnconfirmedInvocationTerminationError) => void,
    cleanupTimeoutMs: number,
  ) => Effect.Effect<void, unknown>,
  terminationTimeoutMs = OWNED_CLEANUP_TIMEOUT_MS,
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
    ownerId: invocationId,
    ownerAncestors: context.workspaceOwnerAncestors,
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
  const ownership: {
    retain: boolean;
    uncertainty?: UnconfirmedInvocationTerminationError;
  } = {
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
      const parentSpan = yield* Effect.currentParentSpan.pipe(Effect.option);
      const tracer = yield* Tracer.Tracer;
      const nativeContext = yield* Effect.context<never>();
      const output = yield* withBodyPermit(
        Effect.suspend(() => {
          if (abortSignal.aborted)
            return Effect.fail(
              abortSignal.aborted
                ? abortSignal.reason
                : new Error("Task execution cancelled"),
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
                  nativeContext,
                  ...(Option.isSome(parentSpan)
                    ? {
                        nativeTelemetry: {
                          tracer,
                          parentSpan: parentSpan.value,
                        },
                      }
                    : {}),
                  terminationTimeoutMs,
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
            Effect.flatMap(
              Effect.exit(
                restore(
                  Effect.raceFirst(execution, awaitAbortSignal(abortSignal)),
                ),
              ),
              (exit) => {
                const settled = Effect.promise(
                  () =>
                    pending?.then(
                      () => undefined,
                      () => undefined,
                    ) ?? Promise.resolve(),
                ).pipe(Effect.timeoutOption(terminationTimeoutMs));
                return Effect.flatMap(settled, (didSettle) => {
                  if (Option.isNone(didSettle)) {
                    const uncertainty = retainUnconfirmed(
                      new UnconfirmedInvocationTerminationError("timeout"),
                    );
                    observeLateFailure(pending, uncertainty);
                    return Effect.fail(uncertainty);
                  }
                  return Effect.suspend(() =>
                    ownership.uncertainty !== undefined
                      ? Effect.fail(ownership.uncertainty)
                      : Exit.isSuccess(exit)
                        ? Effect.succeed(exit.value)
                        : Effect.failCause(exit.cause),
                  );
                });
              },
            ),
          );
        }),
      );
      if (afterBody !== undefined) {
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.flatMap(
            Effect.exit(
              restore(
                Effect.raceFirst(
                  afterBody(output, retainUnconfirmed, terminationTimeoutMs),
                  awaitAbortSignal(abortSignal),
                ),
              ),
            ),
            (exit) => {
              const cause = Exit.isFailure(exit)
                ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
                : undefined;
              const uncertain =
                findUnconfirmedInvocationTermination(cause) ??
                findUnconfirmedInvocationTermination(ownership.uncertainty);
              if (uncertain !== undefined) {
                retainUnconfirmed(uncertain);
                return Effect.fail(ownership.uncertainty);
              }
              return Exit.isSuccess(exit)
                ? Effect.void
                : Effect.failCause(exit.cause);
            },
          ),
        );
      }
      return output;
    }),
  );

  function retainUnconfirmed(
    error: UnconfirmedInvocationTerminationError,
  ): UnconfirmedInvocationTerminationError {
    ownership.retain = true;
    ownership.uncertainty ??= error;
    const uncertainty = ownership.uncertainty;
    if (session !== undefined)
      context.sessionLocks.quarantine(session, uncertainty);
    context.workspaceLocks.quarantine(resource, uncertainty);
    return uncertainty;
  }
}

function awaitAbortSignal(signal: AbortSignal): Effect.Effect<never, unknown> {
  const failure = () =>
    signal.aborted ? signal.reason : new Error("Task execution cancelled");
  if (signal.aborted) return Effect.fail(failure());
  return Effect.callback((resume) => {
    const onAbort = (): void => resume(Effect.fail(failure()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function observeLateFailure(
  pending: Promise<unknown> | undefined,
  uncertainty: UnconfirmedInvocationTerminationError,
): void {
  void pending?.then(
    () => undefined,
    (cause: unknown) => uncertainty.attachCause(cause),
  );
}
