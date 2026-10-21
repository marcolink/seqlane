import { Effect } from "effect";
import type { RepeatNode, RunnableNode } from "@seqlane/core";
import type { ExecutionContext } from "./context.js";
import { executeTaskNodeEffect } from "../invocation/task-admission.js";
import { completeValidatedTaskEffect } from "../invocation/deferred-task-completion.js";
import { validateRunnableOutputEffect } from "../validation/output-validation-effect.js";
import type { CompileWorkflowOptions } from "../compile/compile-plan.js";
import {
  invocationKind,
  invocationSubject,
  invocationTaskId,
} from "./workflow-run.js";
import {
  taskIdCompatibility,
  terminalizeDynamicInvocation,
} from "../invocation/invocation-support.js";
import { toSeqlaneDisplayValue } from "./display-value.js";
import { getTaskSchema } from "../plan/task-schema.js";
import { prepareTaskInput } from "../invocation/invocation-execution.js";
import { resolveRepeatAttemptSession } from "../session/session-preflight.js";

/** Runs one dynamic repeat attempt through input, session, body and validation lifecycles. */
export function executeRepeatAttemptEffect(options: {
  readonly context: ExecutionContext;
  readonly node: RepeatNode;
  readonly attemptNode: RunnableNode;
  readonly invocationId: string;
  readonly attemptInvocationId: string;
  readonly iteration: number;
  readonly currentInput: unknown;
  readonly attemptInputId: string;
  readonly previousAttemptInvocationId?: string;
  readonly abortSignal: AbortSignal;
  readonly withBodyPermit: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  readonly executeWorkflow: CompileWorkflowOptions["executeWorkflow"];
}): Effect.Effect<unknown, unknown> {
  const {
    context,
    node,
    attemptNode,
    invocationId,
    attemptInvocationId,
    iteration,
    currentInput,
    attemptInputId,
    previousAttemptInvocationId,
    abortSignal,
    withBodyPermit,
    executeWorkflow,
  } = options;
  const attemptContext: ExecutionContext = {
    ...context,
    invocationIds: new Map(context.invocationIds).set(
      attemptNode.nodeId,
      attemptInvocationId,
    ),
  };
  context.results.set(attemptInputId, currentInput);
  const subject = invocationSubject(attemptNode);
  context.events.emit({
    type: "invocation.created",
    workId: context.workId,
    runId: context.runId,
    invocationId: attemptInvocationId,
    planNodeId: attemptNode.nodeId,
    subject,
    ...taskIdCompatibility(subject),
    kind: invocationKind(attemptNode),
    label: invocationTaskId(attemptNode),
    parentInvocationId: invocationId,
    siblingOrder: iteration - 1,
    dependencyIds: [
      ...attemptNode.dependsOn.flatMap((dependencyId) => {
        const dependencyInvocationId = context.invocationIds.get(dependencyId);
        return dependencyInvocationId === undefined
          ? []
          : [dependencyInvocationId];
      }),
      ...(previousAttemptInvocationId === undefined
        ? []
        : [previousAttemptInvocationId]),
    ],
    iteration,
  });
  const failAttempt = (cause: unknown) =>
    Effect.sync(() => {
      terminalizeDynamicInvocation(cause, {
        context,
        abortSignal,
        invocationId: attemptInvocationId,
        taskId: invocationTaskId(attemptNode),
        iteration,
      });
    }).pipe(Effect.andThen(Effect.fail(cause)));

  return Effect.gen(function* () {
    const preparedInput =
      attemptNode.type === "task"
        ? yield* Effect.catch(
            Effect.try({
              try: () =>
                prepareTaskInput(
                  attemptContext,
                  attemptNode,
                  {
                    invocationId: attemptInvocationId,
                    observability: {},
                    results: context.results,
                    remainingConsumers: context.remainingConsumers,
                    subject: { type: "task", taskId: attemptNode.taskId },
                    iteration,
                  },
                  abortSignal,
                  getTaskSchema(
                    context.taskSchemas,
                    attemptNode.taskId,
                    context.taskDefinitions,
                  ).input,
                ),
              catch: (cause) => cause,
            }),
            failAttempt,
          )
        : undefined;

    if (attemptNode.type === "task") {
      yield* Effect.catch(
        Effect.tryPromise({
          try: () =>
            resolveRepeatAttemptSession(
              context,
              attemptNode,
              attemptInvocationId,
            ),
          catch: (cause) => cause,
        }),
        failAttempt,
      );
      return yield* Effect.catch(
        executeTaskNodeEffect(
          attemptContext,
          attemptNode,
          abortSignal,
          {
            invocationId: attemptInvocationId,
            observability: {},
            results: context.results,
            remainingConsumers: context.remainingConsumers,
            subject: { type: "task", taskId: attemptNode.taskId },
            iteration,
            deferCompletion: true,
            ...(preparedInput === undefined ? {} : { preparedInput }),
          },
          withBodyPermit,
          completeValidatedTaskEffect({
            context,
            node: attemptNode,
            invocationId: attemptInvocationId,
            iteration,
            validation: node.validation,
            abortSignal,
            withBodyPermit,
          }),
        ),
        failAttempt,
      );
    }

    if (executeWorkflow === undefined) {
      return yield* Effect.fail(
        new Error(`Repeat "${node.nodeId}" has no workflow executor`),
      );
    }
    const output = yield* Effect.catch(
      executeWorkflow(
        attemptContext,
        attemptNode,
        abortSignal,
        withBodyPermit,
        true,
      ),
      failAttempt,
    );
    yield* Effect.catch(
      validateRunnableOutputEffect(
        context,
        attemptNode,
        output,
        node.validation,
        abortSignal,
        { invocationId: attemptInvocationId, iteration, withBodyPermit },
      ),
      failAttempt,
    );
    context.events.emit({
      type: "invocation.result",
      workId: context.workId,
      runId: context.runId,
      invocationId: attemptInvocationId,
      result: toSeqlaneDisplayValue(output),
      iteration,
    });
    context.events.emit({
      type: "invocation.succeeded",
      workId: context.workId,
      runId: context.runId,
      invocationId: attemptInvocationId,
      iteration,
    });
    return output;
  });
}
