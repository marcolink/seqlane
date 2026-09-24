import type { OutputEvent, RunNode } from "./run-view-model.js";

type ActivityEvent = Extract<OutputEvent, { type: "invocation.activity" }>;

export function activityIdentity(event: ActivityEvent): string {
  return JSON.stringify([event.invocationId, event.kind, event.activityId]);
}

function retainActivityDetails(
  node: RunNode,
  event: ActivityEvent,
): ReadonlyMap<string, ActivityEvent> {
  const identity = activityIdentity(event);
  const previous = node.activityDetails.get(identity);
  const details = new Map(node.activityDetails);
  details.set(identity, {
    ...previous,
    ...event,
    input: event.input ?? previous?.input,
    output: event.output ?? previous?.output,
    activityMetadata: event.activityMetadata ?? previous?.activityMetadata,
    startedAt: event.startedAt ?? previous?.startedAt,
    endedAt: event.endedAt ?? previous?.endedAt,
    message: event.message ?? previous?.message,
  });
  return details;
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
  const activityDetails = retainActivityDetails(node, event);
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
  const usage = new Map(
    event.kind === "skill" ? node.skillUsage : node.toolUsage,
  );
  if (isNewActivity) {
    usage.set(event.name, (usage.get(event.name) ?? 0) + 1);
  }
  return {
    ...node,
    completedToolIds,
    seenActivityIds,
    liveActivities,
    activityDetails,
    ...(event.kind === "skill" ? { skillUsage: usage } : { toolUsage: usage }),
    activity:
      event.message ?? event.kind + " " + event.name + " " + event.state,
  };
}
