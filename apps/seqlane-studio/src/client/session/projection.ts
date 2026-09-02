import type { SeqlaneDisplayValue } from "@seqlane/core";
import type {
  StudioExecutionEvent,
  StudioInvocationSnapshot,
  StudioRunSnapshot,
  StudioRunSummary,
  StudioRunsSnapshot,
  StudioStreamEvent,
} from "@seqlane/studio/protocol";
import {
  initialValidationSnapshot,
  studioPlanSnapshot,
  validationFromDisplayResult,
  validationFromFailure,
} from "@seqlane/studio/protocol";

export interface StudioBrowserState {
  readonly runs: ReadonlyMap<string, StudioRunSummary>;
  readonly snapshots: ReadonlyMap<string, StudioRunSnapshot>;
  readonly timeline: ReadonlyMap<string, readonly StudioStreamEvent[]>;
  readonly toolUsage: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly skillUsage: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly sequenceGaps: ReadonlyMap<string, boolean>;
  readonly cursor: number;
}

const MAX_INVOCATION_ACTIVITIES = 100;

function activityUsageFromSnapshot(snapshot: StudioRunSnapshot): {
  readonly tool: Map<string, number>;
  readonly skill: Map<string, number>;
} {
  const tool = new Map<string, number>();
  const skill = new Map<string, number>();
  for (const usage of snapshot.toolUsage ?? [])
    tool.set(usage.name, usage.count);
  for (const usage of snapshot.skillUsage ?? [])
    skill.set(usage.name, usage.count);
  if (snapshot.toolUsage !== undefined || snapshot.skillUsage !== undefined) {
    return { tool, skill };
  }
  for (const invocation of snapshot.invocations) {
    for (const activity of invocation.activities ?? []) {
      const counts = activity.kind === "skill" ? skill : tool;
      counts.set(activity.name, (counts.get(activity.name) ?? 0) + 1);
    }
  }
  return { tool, skill };
}

function addActivityUsage(
  usage: {
    readonly tool: Map<string, number>;
    readonly skill: Map<string, number>;
  },
  stream: StudioStreamEvent,
): void {
  if (stream.event.type !== "invocation.activity") return;
  const counts = stream.event.kind === "skill" ? usage.skill : usage.tool;
  counts.set(stream.event.name, (counts.get(stream.event.name) ?? 0) + 1);
}

export function createBrowserState(): StudioBrowserState {
  return {
    runs: new Map(),
    snapshots: new Map(),
    timeline: new Map(),
    toolUsage: new Map(),
    skillUsage: new Map(),
    sequenceGaps: new Map(),
    cursor: 0,
  };
}

function timestamp(event: StudioExecutionEvent): string | undefined {
  return event.metadata?.occurredAt;
}

function updateInvocation(
  snapshot: StudioRunSnapshot,
  invocationId: string,
  update: (invocation: StudioInvocationSnapshot) => StudioInvocationSnapshot,
): StudioRunSnapshot {
  const index = snapshot.invocations.findIndex(
    (invocation) => invocation.invocationId === invocationId,
  );
  if (index < 0) return snapshot;
  const invocations = [...snapshot.invocations];
  const invocation = invocations[index];
  if (invocation === undefined) return snapshot;
  invocations[index] = update(invocation);
  return { ...snapshot, invocations };
}

function activeInvocationCount(
  invocations: readonly StudioInvocationSnapshot[],
): number {
  return invocations.filter(
    ({ state }) => state === "active" || state === "retrying",
  ).length;
}

function isTerminalInvocationState(
  state: StudioInvocationSnapshot["state"],
): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

function withSummary(
  snapshot: StudioRunSnapshot,
  summary: Partial<StudioRunSummary>,
  cursor: number,
  hasSequenceGap: boolean,
): StudioRunSnapshot {
  const nextSummary = {
    ...snapshot.summary,
    ...summary,
    activeInvocationCount: activeInvocationCount(snapshot.invocations),
    isIncomplete: hasSequenceGap || nextPlanMissing(snapshot),
    lastEventSequence:
      snapshot.summary.lastEventSequence >
      (summary.lastEventSequence ?? snapshot.summary.lastEventSequence)
        ? snapshot.summary.lastEventSequence
        : (summary.lastEventSequence ?? snapshot.summary.lastEventSequence),
  };
  return { ...snapshot, summary: nextSummary, cursor };
}

function nextPlanMissing(snapshot: StudioRunSnapshot): boolean {
  return snapshot.plan === undefined;
}

function reduceSnapshot(
  snapshot: StudioRunSnapshot,
  stream: StudioStreamEvent,
  hasSequenceGap: boolean,
): StudioRunSnapshot {
  const event = stream.event;
  const eventSequence = event.metadata?.sequence ?? 0;
  let next = snapshot;

  switch (event.type) {
    case "run.plan":
      next = { ...snapshot, plan: studioPlanSnapshot(event.plan) };
      break;
    case "invocation.created":
      next = {
        ...snapshot,
        invocations: [
          ...snapshot.invocations,
          {
            invocationId: event.invocationId,
            planNodeId: event.planNodeId,
            taskId:
              event.taskId ??
              (event.subject.type === "task"
                ? event.subject.taskId
                : event.subject.type === "validator"
                  ? event.subject.validatorId
                  : event.subject.planNodeId),
            kind: event.kind,
            label: event.label,
            ...(event.parentInvocationId === undefined
              ? {}
              : { parentInvocationId: event.parentInvocationId }),
            ...(event.iteration === undefined
              ? {}
              : { iteration: event.iteration }),
            siblingOrder: event.siblingOrder,
            dependencyIds: [...event.dependencyIds],
            state: "queued",
            activities: [],
            output: { persistent: [] },
            ...(initialValidationSnapshot(event) === undefined
              ? {}
              : { validation: initialValidationSnapshot(event) }),
          },
        ],
      };
      break;
    case "invocation.input":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        input: event.input,
      }));
      break;
    case "invocation.result":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        result: event.result,
        validation: validationFromDisplayResult(
          invocation.validation,
          event.result,
        ),
      }));
      break;
    case "invocation.started":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        state: "active",
        startedAt: invocation.startedAt ?? timestamp(event),
      }));
      break;
    case "invocation.progress":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        state: isTerminalInvocationState(invocation.state)
          ? invocation.state
          : event.state,
        label: event.label ?? invocation.label,
        dependencyIds: event.dependencyIds ?? invocation.dependencyIds,
        ...(event.iteration === undefined
          ? {}
          : { iteration: event.iteration }),
        startedAt: invocation.startedAt ?? timestamp(event),
      }));
      break;
    case "invocation.output":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        output:
          event.policy === "persistent"
            ? {
                ...invocation.output,
                persistent: [...invocation.output.persistent, event.content],
                ...(event.metrics === undefined
                  ? {}
                  : { metrics: event.metrics }),
                ...(event.summary === undefined
                  ? {}
                  : { summary: event.summary }),
              }
            : {
                ...invocation.output,
                transient: event.content,
                ...(event.metrics === undefined
                  ? {}
                  : { metrics: event.metrics }),
                ...(event.summary === undefined
                  ? {}
                  : { summary: event.summary }),
              },
      }));
      break;
    case "invocation.activity":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => {
        const activities = [
          ...(invocation.activities ?? []),
          {
            activityId: event.activityId,
            kind: event.kind,
            name: event.name,
            state: event.state,
            ...(event.input === undefined ? {} : { input: event.input }),
            ...(event.output === undefined ? {} : { output: event.output }),
            ...(event.activityMetadata === undefined
              ? {}
              : { activityMetadata: event.activityMetadata }),
            ...(event.startedAt === undefined
              ? {}
              : { startedAt: event.startedAt }),
            ...(event.endedAt === undefined ? {} : { endedAt: event.endedAt }),
            ...(event.message === undefined ? {} : { message: event.message }),
            ...(event.iteration === undefined
              ? {}
              : { iteration: event.iteration }),
            occurredAt: timestamp(event) ?? "",
          },
        ];
        return {
          ...invocation,
          activities: activities.slice(-MAX_INVOCATION_ACTIVITIES),
        };
      });
      break;
    case "invocation.retrying":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        state: "retrying",
        startedAt: invocation.startedAt ?? timestamp(event),
      }));
      break;
    case "invocation.succeeded":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        state: "succeeded",
        finishedAt: timestamp(event),
      }));
      break;
    case "invocation.failed":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        state: "failed",
        error: event.error,
        ...(event.error.validation === undefined
          ? {}
          : {
              validation: validationFromFailure(
                invocation.validation,
                event.error.validation,
              ),
            }),
        finishedAt: timestamp(event),
      }));
      break;
    case "invocation.skipped":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        state: "skipped",
        dependencyIds: event.dependencyIds ?? invocation.dependencyIds,
        finishedAt: timestamp(event),
      }));
      break;
    case "invocation.cancelled":
      next = updateInvocation(snapshot, event.invocationId, (invocation) => ({
        ...invocation,
        state: "cancelled",
        finishedAt: timestamp(event),
      }));
      break;
    default:
      break;
  }

  const isTerminalRun =
    event.type === "run.succeeded" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled";
  const runState =
    event.type === "run.succeeded"
      ? "succeeded"
      : event.type === "run.failed"
        ? "failed"
        : event.type === "run.cancelled"
          ? "cancelled"
          : event.type === "run.started"
            ? "active"
            : next.summary.state;

  return withSummary(
    next,
    {
      state: runState,
      isIncomplete:
        next.summary.isIncomplete ||
        eventSequence > next.summary.lastEventSequence + 1,
      ...(event.type === "run.started" ? { startedAt: timestamp(event) } : {}),
      ...(isTerminalRun ? { finishedAt: timestamp(event) } : {}),
      lastEventSequence: eventSequence,
    },
    stream.cursor,
    hasSequenceGap,
  );
}

function createSnapshot(
  stream: StudioStreamEvent,
): StudioRunSnapshot | undefined {
  if (stream.event.type !== "run.started") return undefined;
  return {
    summary: {
      workId: stream.event.workId,
      runId: stream.event.runId,
      workflowId: stream.workflowId,
      state: "active",
      isIncomplete: (stream.event.metadata?.sequence ?? 1) !== 1,
      startedAt: timestamp(stream.event),
      activeInvocationCount: 0,
      lastEventSequence: stream.event.metadata?.sequence ?? 0,
    },
    cursor: stream.cursor,
    invocations: [],
  };
}

export function applyStreamEvent(
  state: StudioBrowserState,
  stream: StudioStreamEvent,
): StudioBrowserState {
  const runId = stream.event.runId;
  const current = state.snapshots.get(runId);
  if (
    current !== undefined &&
    (stream.event.metadata?.sequence ?? 0) <= current.summary.lastEventSequence
  ) {
    return { ...state, cursor: Math.max(state.cursor, stream.cursor) };
  }
  const snapshot = current ?? createSnapshot(stream);
  if (snapshot === undefined) return state;
  const eventSequence = stream.event.metadata?.sequence ?? 0;
  const hasSequenceGap =
    (state.sequenceGaps.get(runId) ?? false) ||
    (current !== undefined &&
      eventSequence > current.summary.lastEventSequence + 1) ||
    (current === undefined && eventSequence !== 1);
  const nextSnapshot = reduceSnapshot(snapshot, stream, hasSequenceGap);
  const runs = new Map(state.runs);
  runs.set(runId, nextSnapshot.summary);
  const snapshots = new Map(state.snapshots);
  snapshots.set(runId, nextSnapshot);
  const timeline = new Map(state.timeline);
  timeline.set(runId, [
    ...(state.timeline.get(runId) ?? []).slice(-199),
    stream,
  ]);
  const sequenceGaps = new Map(state.sequenceGaps);
  sequenceGaps.set(runId, hasSequenceGap);
  const toolUsage = new Map(state.toolUsage);
  const runToolUsage = new Map(toolUsage.get(runId));
  const skillUsage = new Map(state.skillUsage);
  const runSkillUsage = new Map(skillUsage.get(runId));
  addActivityUsage({ tool: runToolUsage, skill: runSkillUsage }, stream);
  toolUsage.set(runId, runToolUsage);
  skillUsage.set(runId, runSkillUsage);
  return {
    runs,
    snapshots,
    timeline,
    toolUsage,
    skillUsage,
    sequenceGaps,
    cursor: Math.max(state.cursor, stream.cursor),
  };
}

export function applyRunsSnapshot(
  state: StudioBrowserState,
  snapshot: StudioRunsSnapshot,
): StudioBrowserState {
  const runs = new Map(state.runs);
  for (const run of snapshot.runs) runs.set(run.runId, run);
  return { ...state, runs, cursor: Math.max(state.cursor, snapshot.cursor) };
}

export function setRunSnapshot(
  state: StudioBrowserState,
  snapshot: StudioRunSnapshot,
): StudioBrowserState {
  const currentSnapshot = state.snapshots.get(snapshot.summary.runId);
  let snapshotToStore = snapshot;
  let preserveCurrentSequenceGap = false;
  if (
    currentSnapshot !== undefined &&
    snapshot.cursor < currentSnapshot.cursor
  ) {
    snapshotToStore = currentSnapshot;
    preserveCurrentSequenceGap = true;
  }
  const snapshots = new Map(state.snapshots);
  const runs = new Map(state.runs);
  snapshots.set(snapshot.summary.runId, snapshotToStore);
  runs.set(snapshot.summary.runId, snapshotToStore.summary);
  const sequenceGaps = new Map(state.sequenceGaps);
  if (!preserveCurrentSequenceGap) {
    sequenceGaps.set(
      snapshot.summary.runId,
      snapshot.summary.isIncomplete && snapshot.plan !== undefined,
    );
  }
  const usage = activityUsageFromSnapshot(snapshot);
  for (const stream of state.timeline.get(snapshot.summary.runId) ?? []) {
    if (stream.cursor > snapshot.cursor) addActivityUsage(usage, stream);
  }
  const toolUsage = new Map(state.toolUsage);
  toolUsage.set(snapshot.summary.runId, usage.tool);
  const skillUsage = new Map(state.skillUsage);
  skillUsage.set(snapshot.summary.runId, usage.skill);
  return {
    ...state,
    snapshots,
    runs,
    toolUsage,
    skillUsage,
    sequenceGaps,
    cursor: Math.max(state.cursor, snapshot.cursor),
  };
}

export function refreshBrowserState(
  state: StudioBrowserState,
  runs: StudioRunsSnapshot,
  detail?: StudioRunSnapshot,
): StudioBrowserState {
  let next = applyRunsSnapshot(state, runs);
  if (detail !== undefined) next = setRunSnapshot(next, detail);
  return next;
}

export function eventDurationMs(
  previous: StudioStreamEvent | undefined,
  current: StudioStreamEvent,
): number | undefined {
  if (previous === undefined) return undefined;
  const previousAt = Date.parse(previous.event.metadata?.occurredAt ?? "");
  const currentAt = Date.parse(current.event.metadata?.occurredAt ?? "");
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) {
    return undefined;
  }
  const duration = currentAt - previousAt;
  return duration < 0 ? undefined : duration;
}

export function formatEventDuration(
  previous: StudioStreamEvent | undefined,
  current: StudioStreamEvent,
): string {
  const duration = eventDurationMs(previous, current);
  if (duration === undefined) return "Start";
  if (duration < 1_000) return `+${duration} ms`;
  if (duration < 60_000) return `+${(duration / 1_000).toFixed(2)} s`;
  if (duration < 3_600_000) return `+${(duration / 60_000).toFixed(1)} min`;
  return `+${(duration / 3_600_000).toFixed(1)} h`;
}

export function timelineAnnotation(
  event: StudioStreamEvent["event"],
  invocations: readonly StudioInvocationSnapshot[],
): { readonly label: string; readonly invocationId?: string } {
  if (!("invocationId" in event)) return { label: "Run" };
  const invocation = invocations.find(
    ({ invocationId }) => invocationId === event.invocationId,
  );
  return {
    label: invocation?.label ?? "Invocation",
    invocationId: event.invocationId,
  };
}

export function resetBrowserState(): StudioBrowserState {
  return createBrowserState();
}

export function displayValueText(value: SeqlaneDisplayValue | undefined): {
  readonly label: string;
  readonly detail?: string;
  readonly raw?: string;
} {
  if (value === undefined) return { label: "Not received" };
  switch (value.state) {
    case "present":
      return { label: "Present", raw: JSON.stringify(value.value, null, 2) };
    case "redacted":
      return { label: "Redacted", detail: "Raw value is protected." };
    case "truncated":
      return {
        label: "Truncated",
        detail: "The selected value exceeded Studio display limits.",
      };
    case "omitted":
      return { label: "Omitted", detail: `Reason: ${value.reason}.` };
  }
  return { label: "Unavailable" };
}
