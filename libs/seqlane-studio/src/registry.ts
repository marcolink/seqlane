import {
  isSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/events";
import type {
  StudioIngestEvent,
  StudioInvocationState,
  StudioInvocationSnapshot,
  StudioInvocationActivity,
  StudioToolUsage,
  StudioPlanSnapshot,
  StudioValidationSnapshot,
  StudioRunSnapshot,
  StudioRunState,
  StudioRunSummary,
  StudioRunsSnapshot,
  StudioStreamEvent,
} from "./protocol.js";
import {
  initialValidationSnapshot,
  validationFromDisplayResult,
  validationFromFailure,
  studioPlanSnapshot,
} from "./protocol.js";

const MAX_STREAM_EVENTS = 2_048;
const MAX_TERMINAL_RUNS = 100;
const MAX_INVOCATION_ACTIVITIES = 100;

type RegistryErrorCode = "INVALID_REQUEST" | "NOT_FOUND";

export class StudioRegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioRegistryError";
  }
}

interface MutableInvocation {
  invocationId: StudioInvocationSnapshot["invocationId"];
  planNodeId: StudioInvocationSnapshot["planNodeId"];
  taskId: string;
  kind: StudioInvocationSnapshot["kind"];
  label: string;
  parentInvocationId?: string;
  iteration?: number;
  siblingOrder: number;
  dependencyIds: string[];
  state: StudioInvocationSnapshot["state"];
  input?: StudioInvocationSnapshot["input"];
  result?: StudioInvocationSnapshot["result"];
  activities: StudioInvocationActivity[];
  output: {
    transient?: string;
    persistent: string[];
    metrics?: StudioInvocationSnapshot["output"]["metrics"];
    summary?: StudioInvocationSnapshot["output"]["summary"];
  };
  validation?: StudioValidationSnapshot;
  error?: StudioInvocationSnapshot["error"];
  startedAt?: string;
  finishedAt?: string;
}

interface RunRecord {
  readonly workflowId: string;
  readonly workId: string;
  readonly runId: string;
  readonly invocations: Map<string, MutableInvocation>;
  readonly toolUsage: Map<string, number>;
  readonly skillUsage: Map<string, number>;
  readonly seenSequences: Map<number, string>;
  readonly seenEventIds: Set<string>;
  plan?: StudioPlanSnapshot;
  state: StudioRunState;
  isIncomplete: boolean;
  hasSequenceGap: boolean;
  startedAt?: string;
  finishedAt?: string;
  lastEventSequence: number;
  lastCursor: number;
  terminalCursor?: number;
}

function metadataOf(
  event: SeqlaneExecutionEvent,
): SeqlaneExecutionEvent["metadata"] {
  return event.metadata;
}

function timestampOf(event: SeqlaneExecutionEvent): string {
  return event.metadata.occurredAt;
}

function isTerminalState(state: StudioRunState): boolean {
  return state !== "active";
}

function isActiveInvocation(state: MutableInvocation["state"]): boolean {
  return state === "active" || state === "retrying";
}

function isTerminalInvocationState(state: StudioInvocationState): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

function applyInvocationEvent(
  record: RunRecord,
  event: SeqlaneExecutionEvent,
): void {
  if (event.type === "invocation.created") {
    record.invocations.set(event.invocationId, {
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
      ...(event.iteration === undefined ? {} : { iteration: event.iteration }),
      siblingOrder: event.siblingOrder,
      dependencyIds: [...event.dependencyIds],
      state: "queued",
      activities: [],
      output: { persistent: [] },
      ...(initialValidationSnapshot(event) === undefined
        ? {}
        : { validation: initialValidationSnapshot(event) }),
    });
    return;
  }

  if (
    event.type === "run.started" ||
    event.type === "run.plan" ||
    event.type === "run.succeeded" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.heartbeat"
  ) {
    return;
  }

  const invocation = record.invocations.get(event.invocationId);
  if (invocation === undefined) return;
  const timestamp = timestampOf(event);

  switch (event.type) {
    case "invocation.input":
      invocation.input = event.input;
      return;
    case "invocation.result":
      invocation.result = event.result;
      invocation.validation = validationFromDisplayResult(
        invocation.validation,
        event.result,
      );
      return;
    case "invocation.started":
      invocation.state = "active";
      invocation.startedAt ??= timestamp;
      return;
    case "invocation.progress":
      if (!isTerminalInvocationState(invocation.state)) {
        invocation.state = event.state;
      }
      invocation.startedAt ??= timestamp;
      if (event.label !== undefined) invocation.label = event.label;
      if (event.iteration !== undefined) invocation.iteration = event.iteration;
      if (event.dependencyIds !== undefined) {
        invocation.dependencyIds = [...event.dependencyIds];
      }
      return;
    case "invocation.output":
      if (event.policy === "persistent") {
        invocation.output.persistent.push(event.content);
      } else {
        invocation.output.transient = event.content;
      }
      if (event.metrics !== undefined)
        invocation.output.metrics = event.metrics;
      if (event.summary !== undefined)
        invocation.output.summary = event.summary;
      return;
    case "invocation.activity":
      {
        const usage =
          event.kind === "skill" ? record.skillUsage : record.toolUsage;
        usage.set(event.name, (usage.get(event.name) ?? 0) + 1);
      }
      invocation.activities.push({
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
        occurredAt: timestamp,
      });
      if (invocation.activities.length > MAX_INVOCATION_ACTIVITIES) {
        invocation.activities.splice(
          0,
          invocation.activities.length - MAX_INVOCATION_ACTIVITIES,
        );
      }
      return;
    case "invocation.retrying":
      invocation.state = "retrying";
      invocation.startedAt ??= timestamp;
      return;
    case "invocation.succeeded":
      invocation.state = "succeeded";
      invocation.finishedAt = timestamp;
      return;
    case "invocation.failed":
      invocation.state = "failed";
      invocation.error = event.error;
      if (event.error.validation !== undefined) {
        invocation.validation = validationFromFailure(
          invocation.validation,
          event.error.validation,
        );
      }
      invocation.finishedAt = timestamp;
      return;
    case "invocation.skipped":
      invocation.state = "skipped";
      invocation.finishedAt = timestamp;
      if (event.dependencyIds !== undefined) {
        invocation.dependencyIds = [...event.dependencyIds];
      }
      return;
    case "invocation.cancelled":
      invocation.state = "cancelled";
      invocation.finishedAt = timestamp;
      return;
    default:
      return;
  }
}

function applyRunEvent(record: RunRecord, event: SeqlaneExecutionEvent): void {
  const timestamp = timestampOf(event);
  if (event.type === "run.started") {
    record.state = "active";
    record.startedAt ??= timestamp;
  } else if (event.type === "run.succeeded") {
    record.state = "succeeded";
    record.finishedAt = timestamp;
  } else if (event.type === "run.failed") {
    record.state = "failed";
    record.finishedAt = timestamp;
  } else if (event.type === "run.cancelled") {
    record.state = "cancelled";
    record.finishedAt = timestamp;
  } else if (event.type === "run.plan") {
    record.plan = studioPlanSnapshot(event.plan);
    record.isIncomplete = record.hasSequenceGap;
  }
  applyInvocationEvent(record, event);
}

function toInvocationSnapshot(
  invocation: MutableInvocation,
): StudioInvocationSnapshot {
  return {
    invocationId: invocation.invocationId,
    planNodeId: invocation.planNodeId,
    taskId: invocation.taskId,
    kind: invocation.kind,
    label: invocation.label,
    ...(invocation.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: invocation.parentInvocationId }),
    ...(invocation.iteration === undefined
      ? {}
      : { iteration: invocation.iteration }),
    siblingOrder: invocation.siblingOrder,
    dependencyIds: [...invocation.dependencyIds],
    state: invocation.state,
    ...(invocation.input === undefined ? {} : { input: invocation.input }),
    ...(invocation.result === undefined ? {} : { result: invocation.result }),
    activities: invocation.activities.map((activity) => ({ ...activity })),
    output: {
      ...(invocation.output.transient === undefined
        ? {}
        : { transient: invocation.output.transient }),
      persistent: [...invocation.output.persistent],
      ...(invocation.output.metrics === undefined
        ? {}
        : { metrics: invocation.output.metrics }),
      ...(invocation.output.summary === undefined
        ? {}
        : { summary: invocation.output.summary }),
    },
    ...(invocation.validation === undefined
      ? {}
      : { validation: invocation.validation }),
    ...(invocation.error === undefined ? {} : { error: invocation.error }),
    ...(invocation.startedAt === undefined
      ? {}
      : { startedAt: invocation.startedAt }),
    ...(invocation.finishedAt === undefined
      ? {}
      : { finishedAt: invocation.finishedAt }),
  };
}

function toSummary(record: RunRecord): StudioRunSummary {
  return {
    workId: record.workId,
    runId: record.runId,
    workflowId: record.workflowId,
    state: record.state,
    isIncomplete: record.isIncomplete || record.plan === undefined,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.finishedAt === undefined
      ? {}
      : { finishedAt: record.finishedAt }),
    activeInvocationCount: [...record.invocations.values()].filter(
      (invocation) => isActiveInvocation(invocation.state),
    ).length,
    lastEventSequence: record.lastEventSequence,
  };
}

function toToolUsage(record: RunRecord): readonly StudioToolUsage[] {
  return [...record.toolUsage.entries()].map(([name, count]) => ({
    name,
    count,
  }));
}

function toSkillUsage(record: RunRecord): readonly StudioToolUsage[] {
  return [...record.skillUsage.entries()].map(([name, count]) => ({
    name,
    count,
  }));
}

export interface StudioEventReplay {
  readonly reset: boolean;
  readonly events: readonly StudioStreamEvent[];
}

export class StudioRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly stream: StudioStreamEvent[] = [];
  private readonly listeners = new Set<(event: StudioStreamEvent) => void>();
  private cursor = 0;

  get currentCursor(): number {
    return this.cursor;
  }

  ingest(input: StudioIngestEvent): { accepted: boolean; cursor: number } {
    if (typeof input.workflowId !== "string" || input.workflowId.length === 0) {
      throw new StudioRegistryError(
        "INVALID_REQUEST",
        "Studio ingest requires workflowId",
      );
    }
    if (!isSeqlaneExecutionEvent(input.event)) {
      throw new StudioRegistryError(
        "INVALID_REQUEST",
        "Invalid Seqlane execution event",
      );
    }

    const event = input.event;
    const metadata = metadataOf(event);
    let record = this.runs.get(event.runId);
    if (record === undefined) {
      if (event.type !== "run.started") {
        throw new StudioRegistryError(
          "INVALID_REQUEST",
          "The first Studio event for a run must be run.started",
        );
      }
      record = {
        workflowId: input.workflowId,
        workId: event.workId,
        runId: event.runId,
        invocations: new Map(),
        toolUsage: new Map(),
        skillUsage: new Map(),
        seenSequences: new Map(),
        seenEventIds: new Set(),
        state: "active",
        isIncomplete: true,
        hasSequenceGap: metadata.sequence !== 1,
        lastEventSequence: metadata.sequence,
        lastCursor: 0,
      };
      this.runs.set(event.runId, record);
    } else {
      if (record.workflowId !== input.workflowId) {
        throw new StudioRegistryError(
          "INVALID_REQUEST",
          "A run cannot change workflowId",
        );
      }
      if (record.workId !== event.workId) {
        throw new StudioRegistryError(
          "INVALID_REQUEST",
          "A run cannot change workId",
        );
      }
      const knownSequence = record.seenSequences.get(metadata.sequence);
      if (knownSequence !== undefined) {
        if (knownSequence === metadata.eventId) {
          return { accepted: false, cursor: record.lastCursor };
        }
        throw new StudioRegistryError(
          "INVALID_REQUEST",
          "A run cannot reuse an event sequence",
        );
      }
      if (record.seenEventIds.has(metadata.eventId)) {
        throw new StudioRegistryError(
          "INVALID_REQUEST",
          "A run cannot reuse an eventId",
        );
      }
      if (isTerminalState(record.state)) {
        throw new StudioRegistryError(
          "INVALID_REQUEST",
          "A terminal run cannot accept more events",
        );
      }
      if (metadata.sequence > record.lastEventSequence + 1) {
        record.hasSequenceGap = true;
        record.isIncomplete = true;
      }
    }

    record.seenSequences.set(metadata.sequence, metadata.eventId);
    record.seenEventIds.add(metadata.eventId);
    record.lastEventSequence = Math.max(
      record.lastEventSequence,
      metadata.sequence,
    );
    applyRunEvent(record, event);

    const streamEvent: StudioStreamEvent = {
      cursor: ++this.cursor,
      workflowId: input.workflowId,
      event,
    };
    record.lastCursor = streamEvent.cursor;
    this.stream.push(streamEvent);
    if (this.stream.length > MAX_STREAM_EVENTS) this.stream.shift();
    if (isTerminalState(record.state))
      record.terminalCursor ??= streamEvent.cursor;
    this.evictTerminalRuns();
    for (const listener of this.listeners) listener(streamEvent);
    return { accepted: true, cursor: streamEvent.cursor };
  }

  listRuns(): StudioRunsSnapshot {
    return {
      runs: [...this.runs.values()].map(toSummary),
      cursor: this.cursor,
    };
  }

  getRun(runId: string): StudioRunSnapshot {
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new StudioRegistryError("NOT_FOUND", "Studio run not found");
    }
    return {
      summary: toSummary(record),
      cursor: record.lastCursor,
      ...(record.plan === undefined ? {} : { plan: record.plan }),
      invocations: [...record.invocations.values()].map(toInvocationSnapshot),
      toolUsage: toToolUsage(record),
      skillUsage: toSkillUsage(record),
    };
  }

  replayAfter(cursor: number | undefined): StudioEventReplay {
    if (cursor === undefined) return { reset: false, events: [...this.stream] };
    const first = this.stream[0]?.cursor;
    if (first !== undefined && cursor < first - 1) {
      return { reset: true, events: [] };
    }
    return {
      reset: false,
      events: this.stream.filter((event) => event.cursor > cursor),
    };
  }

  subscribe(listener: (event: StudioStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.runs.clear();
    this.stream.length = 0;
    this.cursor = 0;
    this.listeners.clear();
  }

  private evictTerminalRuns(): void {
    const terminal = [...this.runs.values()]
      .filter((record) => isTerminalState(record.state))
      .sort(
        (left, right) =>
          (left.terminalCursor ?? 0) - (right.terminalCursor ?? 0),
      );
    while (terminal.length > MAX_TERMINAL_RUNS) {
      const oldest = terminal.shift();
      if (oldest !== undefined) this.runs.delete(oldest.runId);
    }
  }
}
