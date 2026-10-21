import { Effect } from "effect";
import {
  LoopLimitExceededError,
  MAX_REPEAT_BODY_EXECUTIONS,
  RunRepeatLimitExceededError,
  type RepeatNode,
} from "@seqlane/core";
import type { ExecutionContext } from "./context.js";
import { invocationIdForNode } from "./context.js";
import { resolveBinding, planNodeResult } from "../plan/binding-resolution.js";
import type { CompileWorkflowOptions } from "../compile/compile-plan.js";
import { toSeqlaneDisplayValue } from "./display-value.js";
import { summarizeSeqlaneOutput } from "./output-summary.js";
import { executeRepeatAttemptEffect } from "./effect-repeat-attempt.js";

export function executeRepeatNodeEffect(
  context: ExecutionContext,
  node: RepeatNode,
  abortSignal: AbortSignal,
  withBodyPermit: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  executeWorkflow: CompileWorkflowOptions["executeWorkflow"],
): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    const invocationId = invocationIdForNode(context, node);
    context.events.emit({
      type: "invocation.started",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      subject: { type: "task", taskId: node.nodeId },
      taskId: node.nodeId,
    });
    context.events.emit({
      type: "invocation.progress",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      state: "active",
      phase: "execute",
      message: "Executing repeat",
    });
    context.events.emit({
      type: "invocation.output",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      policy: "transient",
      channel: "task",
      content: "Executing repeat",
    });
    const initialInput = resolveBinding(
      node.input,
      context.workflowInput,
      context.results,
    );
    let currentInput = initialInput;
    let output: unknown;
    let until = false;
    let previousAttemptInvocationId: string | undefined;
    const attemptInputId = `${node.nodeId}:input`;
    const attemptResultId = `${node.nodeId}:attempt`;
    for (
      let iteration = 1;
      iteration <= node.maximumIterations;
      iteration += 1
    ) {
      if (abortSignal.aborted) {
        return yield* Effect.fail(
          abortSignal.reason ?? new Error("Repeat cancelled"),
        );
      }
      context.runState.repeatBudget.executed += 1;
      if (context.runState.repeatBudget.executed > MAX_REPEAT_BODY_EXECUTIONS) {
        return yield* Effect.fail(
          new RunRepeatLimitExceededError(
            MAX_REPEAT_BODY_EXECUTIONS,
            context.runState.repeatBudget.executed,
          ),
        );
      }
      const attemptInvocationId = `${context.runId}:${invocationId}:attempt:${iteration}`;
      const attemptNode = {
        ...node.attempt,
        input: { type: "ref" as const, nodeId: attemptInputId, path: [] },
      };
      const priorAttemptInvocationId = previousAttemptInvocationId;
      previousAttemptInvocationId = attemptInvocationId;
      output = yield* executeRepeatAttemptEffect({
        context,
        node,
        attemptNode,
        invocationId,
        attemptInvocationId,
        iteration,
        currentInput,
        attemptInputId,
        ...(priorAttemptInvocationId === undefined
          ? {}
          : { previousAttemptInvocationId: priorAttemptInvocationId }),
        abortSignal,
        withBodyPermit,
        executeWorkflow,
      });
      context.results.set(attemptResultId, planNodeResult(output));
      const condition = resolveBinding(
        node.until,
        context.workflowInput,
        context.results,
      );
      if (typeof condition !== "boolean") {
        return yield* Effect.fail(
          new Error(
            `Repeat "${node.nodeId}" condition did not resolve to a boolean`,
          ),
        );
      }
      until = condition;
      if (until) {
        context.results.delete(attemptInputId);
        context.results.delete(attemptResultId);
        break;
      }
      if (iteration === node.maximumIterations) {
        context.results.delete(attemptInputId);
        context.results.delete(attemptResultId);
        return yield* Effect.fail(
          new LoopLimitExceededError(node.nodeId, node.maximumIterations),
        );
      }
      currentInput =
        node.nextInput === undefined
          ? initialInput
          : resolveBinding(
              node.nextInput,
              context.workflowInput,
              context.results,
            );
      context.results.delete(attemptInputId);
      context.results.delete(attemptResultId);
    }

    if (!until) {
      return yield* Effect.fail(
        new LoopLimitExceededError(node.nodeId, node.maximumIterations),
      );
    }
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
    context.events.emit({
      type: "invocation.output",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      policy: "persistent",
      channel: "task",
      content: "Repeat completed",
      summary: summarizeSeqlaneOutput(output),
    });
    return output;
  });
}
