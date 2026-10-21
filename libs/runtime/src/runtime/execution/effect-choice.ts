import { Effect } from "effect";
import type { ChoiceNode, WorkflowNode } from "@seqlane/core";
import type { ExecutionContext } from "./context.js";
import { resolveBinding, planNodeResult } from "../plan/binding-resolution.js";
import { executeTaskNodeEffect } from "../invocation/task-admission.js";
import type { CompileWorkflowOptions } from "../compile/compile-plan.js";
import { invocationIdForNode } from "./context.js";
import { toSeqlaneDisplayValue } from "./display-value.js";
import { completeValidatedTaskEffect } from "../invocation/deferred-task-completion.js";
import { validateRunnableOutputEffect } from "../validation/output-validation-effect.js";
import { terminalizeDynamicInvocation } from "../invocation/invocation-support.js";
import { materializeDeferredSessionConsumer } from "../session/session-resolution.js";
import { getTaskSchema } from "../plan/task-schema.js";
import { prepareTaskInput } from "../invocation/invocation-execution.js";
import { preflightSelectedChoiceSessionCapabilities } from "../session/session-preflight.js";
import type { TaskNode } from "@seqlane/core";

export function executeChoiceNodeEffect(
  context: ExecutionContext,
  node: ChoiceNode,
  abortSignal: AbortSignal,
  withBodyPermit: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  executeWorkflow: CompileWorkflowOptions["executeWorkflow"],
  preflightSelectedModel: (node: TaskNode) => Promise<void>,
): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    const invocationId = invocationIdForNode(context, node);
    const selected = resolveBinding(
      node.condition,
      context.workflowInput,
      context.results,
    )
      ? node.then
      : node.else;
    context.events.emit({
      type: "invocation.started",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      subject: { type: "choice", planNodeId: node.nodeId },
    });
    const skipped = selected === node.then ? node.else : node.then;
    const skippedInvocationId = context.invocationIds.get(skipped.nodeId);
    if (skippedInvocationId !== undefined) {
      context.events.emit({
        type: "invocation.skipped",
        workId: context.workId,
        runId: context.runId,
        invocationId: skippedInvocationId,
        reason: "Choice arm not selected",
        dependencyIds: [],
      });
    }

    const selectedInvocationId = context.invocationIds.get(selected.nodeId);
    if (selectedInvocationId === undefined) {
      return yield* Effect.fail(
        new Error(`Choice "${node.nodeId}" has no selected arm identity`),
      );
    }
    const failSelected = (cause: unknown) =>
      Effect.sync(() => {
        terminalizeDynamicInvocation(cause, {
          context,
          abortSignal,
          invocationId: selectedInvocationId,
          taskId: selected.type === "task" ? selected.taskId : selected.nodeId,
        });
      }).pipe(Effect.andThen(Effect.fail(cause)));
    const sessionPolicy =
      selected.type === "task" ? selected.session : undefined;
    const selectedInput =
      selected.type === "task"
        ? yield* Effect.catch(
            Effect.try({
              try: () =>
                prepareTaskInput(
                  context,
                  selected,
                  {
                    invocationId: selectedInvocationId,
                    observability: {},
                    results: context.results,
                    remainingConsumers: context.remainingConsumers,
                    subject: { type: "task", taskId: selected.taskId },
                  },
                  abortSignal,
                  getTaskSchema(
                    context.taskSchemas,
                    selected.taskId,
                    context.taskDefinitions,
                  ).input,
                ),
              catch: (cause) => cause,
            }),
            failSelected,
          )
        : undefined;
    if (selected.type === "task") {
      yield* Effect.catch(
        Effect.tryPromise({
          try: () => preflightSelectedModel(selected),
          catch: (cause) => cause,
        }),
        failSelected,
      );
      const effectiveSelection = context.effectiveModelSelectionsByNode.get(
        selected.nodeId,
      );
      if (effectiveSelection !== undefined) {
        context.effectiveModelSelections.set(
          selectedInvocationId,
          effectiveSelection,
        );
      }
    }
    if (
      selected.type === "task" &&
      (sessionPolicy?.type === "reuse" || sessionPolicy?.type === "fork")
    ) {
      yield* Effect.catch(
        Effect.try({
          try: () =>
            preflightSelectedChoiceSessionCapabilities(context, selected),
          catch: (cause) => cause,
        }),
        failSelected,
      );
      yield* Effect.catch(
        context.choiceSourceGate.waitEffect(sessionPolicy.from, abortSignal),
        failSelected,
      );
      const consumer = context.sessionConsumers
        .get(sessionPolicy.from)
        ?.find((entry) => entry.invocationId === selectedInvocationId);
      if (consumer === undefined) {
        return yield* Effect.fail(
          new Error(`No session consumer for choice arm "${selected.nodeId}"`),
        );
      }
      yield* Effect.catch(
        Effect.tryPromise({
          try: () =>
            materializeDeferredSessionConsumer({
              sourceNodeId: sessionPolicy.from,
              source: context.deferredSessionSources.get(sessionPolicy.from),
              consumer: {
                ...consumer,
                effectiveSelection: context.effectiveModelSelectionsByNode.get(
                  selected.nodeId,
                ),
              },
              resolvedSessions: context.resolvedSessions,
            }),
          catch: (cause) => cause,
        }),
        failSelected,
      );
    }
    let output: unknown;
    if (selected.type === "workflow") {
      if (executeWorkflow === undefined) {
        return yield* Effect.fail(
          new Error(`Choice "${node.nodeId}" has no workflow executor`),
        );
      }
      output = yield* Effect.catch(
        executeWorkflow(
          context,
          selected as WorkflowNode,
          abortSignal,
          withBodyPermit,
          true,
        ),
        failSelected,
      );
    } else {
      output = yield* Effect.catch(
        executeTaskNodeEffect(
          context,
          selected,
          abortSignal,
          {
            invocationId: selectedInvocationId,
            observability: {},
            results: context.results,
            remainingConsumers: context.remainingConsumers,
            subject: { type: "task", taskId: selected.taskId },
            deferCompletion: true,
            ...(selectedInput === undefined
              ? {}
              : { preparedInput: selectedInput }),
          },
          withBodyPermit,
          completeValidatedTaskEffect({
            context,
            node: selected,
            invocationId: selectedInvocationId,
            validation:
              selected === node.then
                ? node.validation?.then
                : node.validation?.else,
            abortSignal,
            withBodyPermit,
          }),
        ),
        (cause) =>
          Effect.sync(() => {
            terminalizeDynamicInvocation(cause, {
              context,
              abortSignal,
              invocationId: selectedInvocationId,
              taskId: selected.taskId,
            });
          }).pipe(Effect.andThen(Effect.fail(cause))),
      );
    }
    if (selected.type === "workflow") {
      yield* Effect.catch(
        validateRunnableOutputEffect(
          context,
          selected,
          output,
          selected === node.then
            ? node.validation?.then
            : node.validation?.else,
          abortSignal,
          { invocationId: selectedInvocationId, withBodyPermit },
        ),
        failSelected,
      );
      context.events.emit({
        type: "invocation.result",
        workId: context.workId,
        runId: context.runId,
        invocationId: selectedInvocationId,
        result: toSeqlaneDisplayValue(output),
      });
      context.events.emit({
        type: "invocation.succeeded",
        workId: context.workId,
        runId: context.runId,
        invocationId: selectedInvocationId,
      });
    }
    context.results.set(selected.nodeId, planNodeResult(output));
    context.results.set(node.nodeId, planNodeResult(output));
    context.events.emit({
      type: "invocation.result",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      result: toSeqlaneDisplayValue(output),
    });
    context.events.emit({
      type: "invocation.succeeded",
      workId: context.workId,
      runId: context.runId,
      invocationId,
    });
    return output;
  });
}
