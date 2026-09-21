import type { OutputEvent, RunNode } from "./run-view-model.js";

type ActivityEvent = Extract<OutputEvent, { type: "invocation.activity" }>;

export function activityIdentity(event: ActivityEvent): string {
  return JSON.stringify([event.invocationId, event.kind, event.activityId]);
}

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
  const identity = activityIdentity(event);
  const isNewActivity = !node.seenActivityIds.has(identity);
  let seenActivityIds = node.seenActivityIds;
  if (isNewActivity) {
    const nextSeenActivityIds = new Set(node.seenActivityIds);
    nextSeenActivityIds.add(identity);
    seenActivityIds = nextSeenActivityIds;
  }
  const terminal =
    node.state === "succeeded" ||
    node.state === "failed" ||
    node.state === "skipped" ||
    node.state === "cancelled";
  let liveActivities = node.liveActivities;
  if (terminal || event.state === "succeeded" || event.state === "failed") {
    if (node.liveActivities.has(event.activityId)) {
      const nextLiveActivities = new Map(node.liveActivities);
      nextLiveActivities.delete(event.activityId);
      liveActivities = nextLiveActivities;
    }
  } else {
    const nextLiveActivities = new Map(node.liveActivities);
    nextLiveActivities.set(event.activityId, event);
    liveActivities = nextLiveActivities;
  }
  return {
    ...node,
    completedToolIds,
    seenActivityIds,
    liveActivities,
    activity:
      event.message ?? event.kind + " " + event.name + " " + event.state,
  };
}
