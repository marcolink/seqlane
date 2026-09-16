import type { OutputEvent, RunNode } from "./run-view-model.js";

/** Keep terminal call counts bounded and independent of streamed progress events. */
export function projectNodeActivity(
  node: RunNode,
  event: Extract<OutputEvent, { type: "invocation.activity" }>,
): RunNode {
  let completedToolIds = node.completedToolIds;
  if (
    event.kind === "tool" &&
    event.state === "succeeded" &&
    (completedToolIds?.size ?? 0) < 1000 &&
    !completedToolIds?.has(event.activityId)
  ) {
    completedToolIds = new Set([...(completedToolIds ?? []), event.activityId]);
  }
  const usage = new Map(
    event.kind === "skill" ? node.skillUsage : node.toolUsage,
  );
  usage.set(event.name, (usage.get(event.name) ?? 0) + 1);
  return {
    ...node,
    ...(event.kind === "skill" ? { skillUsage: usage } : { toolUsage: usage }),
    completedToolIds,
    activity:
      event.message ?? event.kind + " " + event.name + " " + event.state,
  };
}
