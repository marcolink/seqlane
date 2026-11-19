import { Effect } from "effect";
import type { InvocationId, TaskNode } from "@seqlane/core";
import type { ExecutionContext } from "../execution/context.js";
import { settleOwnedPromise } from "../invocation/task-admission.js";
import { preflightSelectedChoiceSessionCapabilities } from "./session-preflight.js";
import {
  materializeDeferredSessionConsumer,
  resolveTaskSession,
} from "./session-resolution.js";

/** Resolve session eligibility after the selected arm's input and model checks. */
export function prepareSelectedChoiceSession(
  context: ExecutionContext,
  node: TaskNode,
  invocationId: InvocationId,
  abortSignal: AbortSignal,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const effectiveSelection = context.effectiveModelSelectionsByNode.get(
      node.nodeId,
    );
    if (effectiveSelection !== undefined) {
      context.effectiveModelSelections.set(invocationId, effectiveSelection);
    }
    yield* Effect.try({
      try: () => preflightSelectedChoiceSessionCapabilities(context, node),
      catch: (cause) => cause,
    });
    const policy = node.session;
    if (policy === undefined) return;
    if (policy.type === "isolated") {
      yield* settleOwnedPromise(() =>
        resolveTaskSession(
          context.resolvedSessions,
          context.sessionResolver,
          context.taskDefinitions,
          invocationId,
          node.taskId,
          effectiveSelection,
        ),
      );
      return;
    }
    yield* context.choiceSourceGate.waitEffect(policy.from, abortSignal);
    const consumer = context.sessionConsumers
      .get(policy.from)
      ?.find((entry) => entry.invocationId === invocationId);
    if (consumer === undefined) {
      return yield* Effect.fail(
        new Error(`No session consumer for choice arm "${node.nodeId}"`),
      );
    }
    yield* settleOwnedPromise(() =>
      materializeDeferredSessionConsumer({
        sourceNodeId: policy.from,
        source: context.deferredSessionSources.get(policy.from),
        consumer: { ...consumer, effectiveSelection },
        resolvedSessions: context.resolvedSessions,
      }),
    );
  });
}
