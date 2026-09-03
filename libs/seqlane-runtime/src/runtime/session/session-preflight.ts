import type { CompiledPlan } from "../compile/compile-plan.js";
import { invocationIdForNode } from "../execution/context.js";
import {
  resolveTaskSession,
  type SessionConsumer,
} from "./session-resolution.js";
import {
  preflightSharedSessionOrder,
  rejectUnorderedSharedSessionPairs,
} from "./shared-session-order.js";

/** Resolves executor sessions and validates session admission before execution. */
export async function resolveCompiledWorkflowSessions(
  compiled: CompiledPlan,
): Promise<void> {
  const { context } = compiled;
  for (const node of compiled.orderedNodes) {
    const invocationId = invocationIdForNode(context, node);
    if (node.type === "task" && node.execution !== "local") {
      const policy = node.session ?? { type: "isolated" as const };
      if (policy.type !== "isolated") {
        const task = context.taskDefinitions?.get(node.taskId);
        if (task === undefined) {
          throw new Error(`No task definition registered for "${node.taskId}"`);
        }
        const consumers = context.sessionConsumers.get(policy.from) ?? [];
        context.sessionConsumers.set(policy.from, [
          ...consumers,
          {
            invocationId,
            task,
            type: policy.type,
            effectiveSelection:
              context.effectiveModelSelections.get(invocationId),
          } satisfies SessionConsumer,
        ]);
        continue;
      }
      await resolveTaskSession(
        context.resolvedSessions,
        context.sessionResolver,
        context.taskDefinitions,
        invocationId,
        node.taskId,
        context.effectiveModelSelections.get(invocationId),
      );
    } else if (
      node.type === "validation.check" &&
      node.source.type === "task"
    ) {
      await resolveTaskSession(
        context.resolvedSessions,
        context.sessionResolver,
        context.taskDefinitions,
        invocationId,
        node.source.taskId,
        context.effectiveModelSelections.get(invocationId),
      );
    }
  }
  context.sharedSessionPairs = preflightSharedSessionOrder(compiled);
  rejectUnorderedSharedSessionPairs(context.sharedSessionPairs);
}
