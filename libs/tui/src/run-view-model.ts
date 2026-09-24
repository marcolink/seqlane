import {
  isJsonValue,
  isPlainRecord,
  validationResultSchema,
} from "@seqlane/core";
import { projectNodeActivity } from "./run-activity.js";
import { outputBytes, retainOutput } from "./run-output.js";
import { withMapChanges } from "./run-node-map.js";
import {
  indexPlanPlaceholders,
  planNodeKind,
  plannedInvocation,
  plannedInvocationForCreated,
  plannedInvocationForSubject,
  reconcileCreatedBatch,
  reconcilePlanPlaceholder,
  reconcileStartedBatch,
} from "./run-plan.js";
import {
  EMPTY_AGGREGATE,
  addAggregate,
  addChildToTopology,
  aggregateDelta,
  aggregateForNode,
  isEmptyAggregate,
  rebuildTopology,
  rootInvocationIds,
} from "./run-topology.js";
import type {
  JsonValue,
  SeqlaneFailureDisposition,
  SeqlaneDisplayValue,
  SeqlaneInvocationKind,
  SeqlaneInvocationMetrics,
  SeqlaneOutputSummary,
} from "@seqlane/core";
import type {
  InvocationActivityEvent,
  InvocationObservationEvent,
  SerializedSeqlaneError,
  SeqlaneExecutionEvent,
} from "@seqlane/protocol";

export type OutputEvent = SeqlaneExecutionEvent;

export type RunValidationVerdict = "passed" | "failed" | "unknown";

export interface RunValidationState {
  readonly validationNodeId: string;
  readonly sourceId: string;
  readonly sourceType: "validator" | "evaluator" | "validation-gate";
  readonly verdict: RunValidationVerdict;
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }[];
  readonly evidence?: SeqlaneDisplayValue;
  /** True only when a false repeat-postcondition verdict keeps the loop going. */
  readonly continued: boolean;
}

export type RunNodeState =
  | "queued"
  | "waiting"
  | "active"
  | "retrying"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface RunAggregate {
  readonly total: number;
  readonly queued: number;
  readonly waiting: number;
  readonly active: number;
  readonly retrying: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: number;
}

export interface RunOutputState {
  readonly retainedBytes?: number;
  /** Total bytes received before projection limits were applied. */
  readonly originalBytes?: number;
  /** Total bytes dropped by projection limits. */
  readonly omittedBytes?: number;
  readonly truncated?: boolean;
  readonly transient?: string;
  readonly persistent: readonly string[];
  readonly metrics?: SeqlaneInvocationMetrics;
  readonly summary?: SeqlaneOutputSummary;
}

export interface RunRetryState {
  readonly attempt: number;
  readonly maximumAttempts?: number;
  readonly delayMs?: number;
  readonly nextAttemptAt?: string;
  readonly lastError: SerializedSeqlaneError;
}

export interface RunFailureState {
  readonly category: SerializedSeqlaneError["category"];
  readonly message: string;
  readonly disposition: SeqlaneFailureDisposition;
}

export interface RunPresentationState {
  readonly isExpanded: boolean;
}

export interface RunNode {
  readonly invocationId: string;
  readonly planNodeId: string;
  readonly taskId: string;
  readonly kind: SeqlaneInvocationKind;
  readonly label: string;
  readonly parentInvocationId?: string;
  readonly iteration?: number;
  readonly siblingOrder: number;
  readonly dependencyIds: readonly string[];
  readonly waitingDependencyLabels: readonly string[];
  readonly state: RunNodeState;
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
  /** Latest live event for each active tool or skill activity. */
  readonly liveActivities: ReadonlyMap<string, InvocationActivityEvent>;
  /** Latest complete activity record for each logical tool or skill activity. */
  readonly activityDetails: ReadonlyMap<string, InvocationActivityEvent>;
  /** Full task input and result display values from canonical invocation events. */
  readonly input?: SeqlaneDisplayValue;
  readonly result?: SeqlaneDisplayValue;
  /** Complete latest lifecycle record for each logical observation. */
  readonly observations: ReadonlyMap<string, InvocationObservationEvent>;
  readonly phase?: string;
  readonly activity?: string;
  readonly workspace?: "shared" | "exclusive";
  readonly session?: Extract<
    OutputEvent,
    { type: "run.plan" }
  >["plan"]["nodes"][number]["session"];
  readonly completedToolIds?: ReadonlySet<string>;
  /** Logical activity identities already counted for this invocation. */
  readonly seenActivityIds: ReadonlySet<string>;
  readonly waitingReason?: string;
  readonly aggregate: RunAggregate;
  readonly output: RunOutputState;
  readonly validation?: RunValidationState;
  readonly retry?: RunRetryState;
  readonly failure?: RunFailureState;
  readonly skipReason?: string;
  readonly continuationReason?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly elapsedMs?: number;
  readonly createdSequence: number;
}

export type RunState = "idle" | "active" | "succeeded" | "failed" | "cancelled";

export interface RunViewModel {
  readonly workflowLabel?: string;
  readonly workId?: string;
  readonly runId?: string;
  readonly runState: RunState;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly runError?: SerializedSeqlaneError;
  readonly nodes: ReadonlyMap<string, RunNode>;
  /** Stable containment index. Normal event updates do not rebuild it. */
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
  /** Reverse dependency index used for bounded placeholder reconciliation. */
  readonly dependentsByDependency: ReadonlyMap<string, readonly string[]>;
  /** Direct lookup for planned invocation placeholders. */
  readonly plannedInvocationByNodeId: ReadonlyMap<string, string>;
  /** Task identity lookup; only one candidate can reconcile without ambiguity. */
  readonly plannedInvocationsByTaskId: ReadonlyMap<string, readonly string[]>;
  /** Automatic expansion state kept separate from execution nodes. */
  readonly presentation: ReadonlyMap<string, RunPresentationState>;
  readonly rootInvocationIds: readonly string[];
  readonly lastHeartbeatAt?: string;
  readonly lastEventSequence: number;
  readonly limits: RunProjectionLimits;
  readonly omittedNodeCount: number;
  /** Exact task count from the latest plan, including omitted projection nodes. */
  readonly plannedTaskCount?: number;
  /** Planned task identities retained even when their rows exceed projection bounds. */
  readonly plannedTaskNodeIds: ReadonlySet<string>;
  /** Runtime task invocations that were not declared by the plan. */
  readonly dynamicTaskCount: number;
  readonly omittedDependencyEdgeCount: number;
  readonly retainedDependencyEdgeCount: number;
  readonly retainedDetailBytes: number;
  readonly omittedDetailBytes: number;
  readonly detailsTruncated?: boolean;
  readonly now: () => Date;
}

export interface RunProjectionLimits {
  readonly nodes: number;
  readonly dependencyEdges: number;
  readonly nodeDetailBytes: number;
  readonly runDetailBytes: number;
}

export const DEFAULT_RUN_PROJECTION_LIMITS: RunProjectionLimits = {
  nodes: 10_000,
  dependencyEdges: 50_000,
  nodeDetailBytes: 32 * 1024,
  runDetailBytes: 16 * 1024 * 1024,
};

export interface RunViewModelOptions {
  readonly now?: () => Date;
  readonly limits?: Partial<RunProjectionLimits>;
}

export interface RunVisibleRow {
  readonly node: RunNode;
  readonly depth: number;
  /** True for each ancestor whose following siblings continue the rail. */
  readonly ancestorRails: readonly boolean[];
  /** Ancestor rails omitted from the bounded visual representation. */
  readonly omittedAncestorRailCount: number;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
}

function boundedDependencies(
  dependencies: readonly string[],
  remaining: number,
): readonly string[] {
  return dependencies.slice(0, Math.max(0, remaining));
}

function eventTimestamp(
  metadata: SeqlaneExecutionEvent["metadata"],
  now: () => Date,
): string {
  if (metadata?.occurredAt !== undefined) return metadata.occurredAt;
  return now().toISOString();
}

function timestampMs(timestamp: string | undefined): number | undefined {
  if (timestamp === undefined) return undefined;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function elapsedBetween(
  startedAt: string | undefined,
  finishedAt: string | undefined,
): number | undefined {
  const started = timestampMs(startedAt);
  const finished = timestampMs(finishedAt);
  if (started === undefined || finished === undefined) return undefined;
  return Math.max(0, finished - started);
}

function emptyNode(
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.created" }>,
  createdSequence: number,
  dependencyIds: readonly string[],
): RunNode {
  const taskId =
    event.taskId ??
    (event.subject.type === "task"
      ? event.subject.taskId
      : event.subject.type === "validator"
        ? event.subject.validatorId
        : event.subject.planNodeId);
  return {
    invocationId: event.invocationId,
    planNodeId: event.planNodeId,
    taskId,
    kind: event.kind,
    label: event.label,
    ...(event.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: event.parentInvocationId }),
    ...(event.iteration === undefined ? {} : { iteration: event.iteration }),
    siblingOrder: event.siblingOrder,
    dependencyIds,
    waitingDependencyLabels: [],
    state: "queued",
    toolUsage: new Map(),
    skillUsage: new Map(),
    liveActivities: new Map(),
    activityDetails: new Map(),
    observations: new Map(),
    seenActivityIds: new Set(),
    aggregate: EMPTY_AGGREGATE,
    output: { persistent: [] },
    ...(event.kind !== "validation"
      ? {}
      : {
          validation: {
            validationNodeId: event.planNodeId,
            sourceId:
              event.subject.type === "validator"
                ? event.subject.validatorId
                : event.subject.type === "task"
                  ? event.subject.taskId
                  : event.planNodeId,
            sourceType:
              event.subject.type === "validator"
                ? ("validator" as const)
                : event.subject.type === "task"
                  ? ("evaluator" as const)
                  : ("validation-gate" as const),
            verdict: "unknown" as const,
            issues: [],
            continued: false,
          },
        }),
    createdSequence,
  };
}

function projectValidationResult(
  display: SeqlaneDisplayValue,
  current: RunValidationState,
): RunValidationState {
  if (display.state !== "present") {
    return { ...current, verdict: "unknown", issues: [], evidence: undefined };
  }
  const parsed = validationResultSchema.safeParse(display.value);
  if (!parsed.success) {
    return { ...current, verdict: "unknown", issues: [], evidence: undefined };
  }
  const { data } = parsed;
  return {
    ...current,
    verdict: data.success ? "passed" : "failed",
    issues: data.success ? [] : data.issues,
    ...(data.evidence === undefined
      ? { evidence: undefined }
      : { evidence: { state: "present", value: data.evidence } }),
    continued: !data.success && current.sourceType === "validation-gate",
  };
}

function projectValidationFailure(
  current: RunValidationState | undefined,
  validation: NonNullable<SerializedSeqlaneError["validation"]>,
): RunValidationState {
  return {
    validationNodeId: validation.validationNodeId,
    sourceId: validation.sourceId,
    sourceType: current?.sourceType ?? "validation-gate",
    verdict: "failed",
    issues: validation.issues,
    ...(validation.evidence === undefined
      ? {}
      : { evidence: validation.evidence }),
    continued: false,
  };
}

function updateNode(
  view: RunViewModel,
  invocationId: string,
  update: (node: RunNode) => RunNode,
): RunViewModel {
  const current = view.nodes.get(invocationId);
  if (current === undefined) return view;
  const updated = update(current);
  const waitingDependencyLabels = updated.dependencyIds
    .map((dependencyId) => view.nodes.get(dependencyId)?.label)
    .filter((label): label is string => label !== undefined);
  const stored =
    updated.kind === "workflow" || updated.kind === "loop"
      ? { ...updated, waitingDependencyLabels }
      : {
          ...updated,
          waitingDependencyLabels,
          aggregate: aggregateForNode(updated),
        };
  const changes = new Map<string, RunNode>([[invocationId, stored]]);
  const delta = aggregateDelta(
    aggregateForNode(updated),
    aggregateForNode(current),
  );
  let parentId = updated.parentInvocationId;
  while (parentId !== undefined && !isEmptyAggregate(delta)) {
    const parent = changes.get(parentId) ?? view.nodes.get(parentId);
    if (parent === undefined) break;
    if (parent.kind === "workflow" || parent.kind === "loop") {
      changes.set(parentId, {
        ...parent,
        aggregate: addAggregate(parent.aggregate, delta),
      });
    }
    parentId = parent.parentInvocationId;
  }
  return { ...view, nodes: withMapChanges(view.nodes, changes) };
}

function updateNodeDependencies(
  view: RunViewModel,
  invocationId: string,
  requestedDependencyIds: readonly string[] | undefined,
  update: (node: RunNode) => RunNode,
): RunViewModel {
  const current = view.nodes.get(invocationId);
  if (current === undefined) return view;
  if (requestedDependencyIds === undefined) {
    return updateNode(view, invocationId, update);
  }
  const remainingEdges =
    view.limits.dependencyEdges -
    view.retainedDependencyEdgeCount +
    current.dependencyIds.length;
  const dependencyIds = boundedDependencies(
    requestedDependencyIds,
    remainingEdges,
  );
  const omittedEdges = requestedDependencyIds.length - dependencyIds.length;
  const dependenciesChanged =
    dependencyIds.length !== current.dependencyIds.length ||
    dependencyIds.some((id, index) => id !== current.dependencyIds[index]);
  const updated = updateNode(view, invocationId, (node) =>
    update({ ...node, dependencyIds }),
  );
  if (!dependenciesChanged && omittedEdges === 0) return updated;

  const dependentsByDependency = new Map(updated.dependentsByDependency);
  for (const dependencyId of current.dependencyIds) {
    const dependents = dependentsByDependency.get(dependencyId);
    if (dependents === undefined) continue;
    const remaining = dependents.filter((id) => id !== invocationId);
    if (remaining.length === 0) dependentsByDependency.delete(dependencyId);
    else dependentsByDependency.set(dependencyId, remaining);
  }
  for (const dependencyId of dependencyIds) {
    const dependents = dependentsByDependency.get(dependencyId) ?? [];
    if (!dependents.includes(invocationId)) {
      dependentsByDependency.set(dependencyId, [...dependents, invocationId]);
    }
  }
  return {
    ...updated,
    dependentsByDependency,
    retainedDependencyEdgeCount:
      view.retainedDependencyEdgeCount -
      current.dependencyIds.length +
      dependencyIds.length,
    omittedDependencyEdgeCount: view.omittedDependencyEdgeCount + omittedEdges,
  };
}

function withState(
  node: RunNode,
  state: RunNodeState,
  timestamp: string,
): RunNode {
  const terminal =
    state === "succeeded" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled";
  // Queue and dependency-wait transitions happen before execution starts.
  // Active establishes the real start; terminal is a zero-duration fallback
  // for incomplete event streams that omit invocation.started.
  const startedAt =
    node.startedAt ?? (state === "active" || terminal ? timestamp : undefined);
  return {
    ...node,
    state,
    startedAt,
    ...(terminal
      ? {
          finishedAt: timestamp,
          elapsedMs: elapsedBetween(startedAt, timestamp),
          liveActivities: new Map(),
        }
      : {}),
  };
}

function isTerminalNodeState(state: RunNodeState): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

function applyAncestorAggregateDelta(
  view: RunViewModel,
  delta: RunAggregate,
  parentInvocationId: string | undefined,
): RunViewModel {
  if (parentInvocationId === undefined || isEmptyAggregate(delta)) return view;
  const nodes = new Map(view.nodes);
  let parentId: string | undefined = parentInvocationId;
  while (parentId !== undefined) {
    const parent = nodes.get(parentId);
    if (parent === undefined) break;
    if (parent.kind === "workflow" || parent.kind === "loop") {
      nodes.set(parentId, {
        ...parent,
        aggregate: addAggregate(parent.aggregate, delta),
      });
    }
    parentId = parent.parentInvocationId;
  }
  return { ...view, nodes };
}

type ActivityEvent = Extract<OutputEvent, { type: "invocation.activity" }>;

function mergeJsonValues(
  previous: JsonValue | undefined,
  next: JsonValue | undefined,
): JsonValue | undefined {
  if (next === undefined) return previous;
  if (previous === undefined) return next;
  if (!isPlainRecord(previous) || !isPlainRecord(next)) return next;
  if (Object.keys(next).length === 0) return next;

  const merged: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (isJsonValue(value)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(next)) {
    if (!isJsonValue(value)) continue;
    const mergedValue = mergeJsonValues(merged[key], value);
    if (mergedValue !== undefined) merged[key] = mergedValue;
  }
  return merged;
}

function mergeObservationAvailability(
  previous: InvocationObservationEvent["availability"],
  next: InvocationObservationEvent["availability"],
): InvocationObservationEvent["availability"] {
  if (next === undefined || previous === undefined || next.length === 0)
    return next ?? previous;

  const merged = [...previous];
  const indexByPath = new Map(
    merged.map((entry, index) => [entry.path, index] as const),
  );
  for (const entry of next) {
    const index = indexByPath.get(entry.path);
    if (index === undefined) {
      indexByPath.set(entry.path, merged.length);
      merged.push(entry);
    } else {
      merged[index] = entry;
    }
  }
  return merged;
}

function mergeInvocationObservation(
  previous: InvocationObservationEvent | undefined,
  next: InvocationObservationEvent,
): InvocationObservationEvent {
  if (previous === undefined) return next;
  const request = mergeJsonValues(previous.model.request, next.model.request);
  const response = mergeJsonValues(
    previous.model.response,
    next.model.response,
  );
  const usage = mergeJsonValues(previous.model.usage, next.model.usage);
  const availability = mergeObservationAvailability(
    previous.availability,
    next.availability,
  );
  return {
    ...previous,
    ...next,
    model: {
      ...previous.model,
      ...next.model,
      ...(request === undefined ? {} : { request }),
      ...(response === undefined ? {} : { response }),
      ...(usage === undefined ? {} : { usage }),
    },
    ...(availability === undefined ? {} : { availability }),
  };
}

function projectActivity(
  view: RunViewModel,
  event: ActivityEvent,
): RunViewModel {
  const node = view.nodes.get(event.invocationId);
  if (node === undefined) return view;
  return updateNode(view, event.invocationId, (current) =>
    projectNodeActivity(current, event),
  );
}

export function createRunViewModel(
  options: RunViewModelOptions = {},
): RunViewModel {
  const view: RunViewModel = {
    runState: "idle",
    nodes: new Map(),
    childrenByParent: new Map(),
    dependentsByDependency: new Map(),
    plannedInvocationByNodeId: new Map(),
    plannedInvocationsByTaskId: new Map(),
    presentation: new Map(),
    rootInvocationIds: [],
    lastEventSequence: 0,
    limits: { ...DEFAULT_RUN_PROJECTION_LIMITS, ...options.limits },
    omittedNodeCount: 0,
    plannedTaskNodeIds: new Set(),
    dynamicTaskCount: 0,
    omittedDependencyEdgeCount: 0,
    retainedDependencyEdgeCount: 0,
    retainedDetailBytes: 0,
    omittedDetailBytes: 0,
    now: options.now ?? (() => new Date()),
  };
  return rebuildTopology(view, view.nodes);
}

function setRunState(
  view: RunViewModel,
  runState: RunState,
  event: OutputEvent,
): RunViewModel {
  const timestamp = eventTimestamp(event.metadata, view.now);
  const terminal =
    runState === "succeeded" ||
    runState === "failed" ||
    runState === "cancelled";
  return {
    ...view,
    workId: "workId" in event ? event.workId : view.workId,
    runId: "runId" in event ? event.runId : view.runId,
    runState,
    ...(runState === "active" && view.startedAt === undefined
      ? { startedAt: timestamp }
      : {}),
    ...(terminal ? { finishedAt: timestamp } : {}),
  };
}

function reduceCreated(
  initial: RunViewModel,
  event: Extract<OutputEvent, { type: "invocation.created" }>,
): RunViewModel {
  const placeholderId = plannedInvocationForCreated(initial, event);
  const view =
    placeholderId !== undefined && placeholderId !== event.invocationId
      ? reconcilePlanPlaceholder(initial, placeholderId, event.invocationId)
      : initial;
  const existing = view.nodes.get(event.invocationId);
  const dynamicTaskDelta =
    placeholderId === undefined &&
    existing === undefined &&
    event.kind === "task" &&
    !view.plannedTaskNodeIds.has(event.planNodeId)
      ? 1
      : 0;
  if (placeholderId !== undefined && placeholderId !== event.invocationId) {
    if (existing === undefined) return view;
  }
  const remainingEdges =
    view.limits.dependencyEdges -
    view.retainedDependencyEdgeCount +
    (existing?.dependencyIds.length ?? 0);
  const dependencyIds = boundedDependencies(
    existing !== undefined &&
      event.dependencyIds.some((id) => !view.nodes.has(id))
      ? existing.dependencyIds
      : event.dependencyIds,
    remainingEdges,
  );
  const omittedEdges = Math.max(
    0,
    event.dependencyIds.length - dependencyIds.length,
  );
  if (existing !== undefined) {
    const parentInvocationId =
      event.parentInvocationId !== undefined &&
      !view.nodes.has(event.parentInvocationId)
        ? existing.parentInvocationId
        : event.parentInvocationId;
    const nodes = new Map(view.nodes);
    nodes.set(event.invocationId, {
      ...existing,
      label: event.label,
      kind: event.kind,
      parentInvocationId,
      ...(event.iteration === undefined
        ? { iteration: undefined }
        : { iteration: event.iteration }),
      siblingOrder: event.siblingOrder,
      dependencyIds,
    });
    for (const dependentId of view.dependentsByDependency.get(
      event.invocationId,
    ) ?? []) {
      const dependent = nodes.get(dependentId);
      if (dependent !== undefined) {
        nodes.set(dependentId, {
          ...dependent,
          waitingDependencyLabels: dependent.dependencyIds
            .map((dependencyId) => nodes.get(dependencyId)?.label)
            .filter((label): label is string => label !== undefined),
        });
      }
    }
    const next = {
      ...view,
      nodes,
      retainedDependencyEdgeCount:
        view.retainedDependencyEdgeCount -
        existing.dependencyIds.length +
        dependencyIds.length,
      omittedDependencyEdgeCount:
        view.omittedDependencyEdgeCount + omittedEdges,
    };
    const topologyChanged =
      parentInvocationId !== existing.parentInvocationId ||
      dependencyIds.length !== existing.dependencyIds.length ||
      dependencyIds.some((id, index) => id !== existing.dependencyIds[index]);
    return topologyChanged ? rebuildTopology(next, nodes) : next;
  }
  if (view.nodes.size >= view.limits.nodes) {
    return {
      ...view,
      omittedNodeCount: view.omittedNodeCount + 1,
      dynamicTaskCount: view.dynamicTaskCount + dynamicTaskDelta,
      omittedDependencyEdgeCount:
        view.omittedDependencyEdgeCount + event.dependencyIds.length,
    };
  }
  const nodes = new Map(view.nodes);
  const node = emptyNode(event, view.lastEventSequence, dependencyIds);
  nodes.set(event.invocationId, node);
  const presentation = new Map(view.presentation);
  presentation.set(event.invocationId, {
    isExpanded: event.kind === "workflow" || event.kind === "loop",
  });
  const dependentsByDependency = new Map(view.dependentsByDependency);
  for (const dependencyId of dependencyIds) {
    dependentsByDependency.set(dependencyId, [
      ...(dependentsByDependency.get(dependencyId) ?? []),
      event.invocationId,
    ]);
  }
  const next = {
    ...view,
    nodes,
    childrenByParent: addChildToTopology(view.childrenByParent, nodes, node),
    dependentsByDependency,
    rootInvocationIds: rootInvocationIds(nodes),
    presentation,
    retainedDependencyEdgeCount:
      view.retainedDependencyEdgeCount + dependencyIds.length,
    omittedDependencyEdgeCount: view.omittedDependencyEdgeCount + omittedEdges,
    dynamicTaskCount: view.dynamicTaskCount + dynamicTaskDelta,
  };
  if (
    view.childrenByParent.has(node.invocationId) ||
    view.dependentsByDependency.has(node.invocationId)
  ) {
    return rebuildTopology(next, nodes);
  }
  return applyAncestorAggregateDelta(
    next,
    aggregateForNode(node),
    node.parentInvocationId,
  );
}

function reducePlan(
  view: RunViewModel,
  event: Extract<OutputEvent, { type: "run.plan" }>,
): RunViewModel {
  const nodes = new Map(view.nodes);
  const presentation = new Map(view.presentation);
  const identities = new Map(
    [...nodes.values()].map((node) => [node.planNodeId, node.invocationId]),
  );
  const accepted = [];
  let omittedNodeCount = view.omittedNodeCount;
  let omittedDependencyEdgeCount = view.omittedDependencyEdgeCount;
  let remainingEdges =
    view.limits.dependencyEdges -
    [...nodes.values()].reduce(
      (sum, node) => sum + node.dependencyIds.length,
      0,
    );
  // Reserve identities first so forward references and existing live nodes resolve.
  for (const node of event.plan.nodes) {
    if (identities.has(node.planNodeId)) continue;
    if (nodes.size + accepted.length >= view.limits.nodes) {
      omittedNodeCount += 1;
      omittedDependencyEdgeCount += node.dependsOn.length;
    } else {
      identities.set(node.planNodeId, `plan:${node.planNodeId}`);
      accepted.push(node);
    }
  }
  for (const node of accepted) {
    const created = plannedInvocation(event, node, identities);
    const dependencies = boundedDependencies(
      created.dependencyIds,
      remainingEdges,
    );
    remainingEdges -= dependencies.length;
    omittedDependencyEdgeCount +=
      created.dependencyIds.length - dependencies.length;
    nodes.set(created.invocationId, {
      ...emptyNode(created, view.lastEventSequence, dependencies),
      session: node.session,
    });
    presentation.set(created.invocationId, {
      isExpanded: created.kind === "workflow" || created.kind === "loop",
    });
  }
  const projected = rebuildTopology(
    {
      ...view,
      presentation,
      omittedNodeCount,
      omittedDependencyEdgeCount,
      retainedDependencyEdgeCount: view.limits.dependencyEdges - remainingEdges,
    },
    nodes,
  );
  return {
    ...setRunState(projected, "active", event),
    ...indexPlanPlaceholders(projected.nodes),
    workflowLabel: event.plan.workflow.id,
    plannedTaskCount: event.plan.nodes.filter(
      (node) => planNodeKind(node) === "task",
    ).length,
    plannedTaskNodeIds: new Set(
      event.plan.nodes
        .filter((node) => planNodeKind(node) === "task")
        .map((node) => node.planNodeId),
    ),
  };
}

function materializePlanPlaceholder(
  view: RunViewModel,
  invocationId: string,
  subject: Extract<OutputEvent, { type: "invocation.started" }>["subject"],
): RunViewModel {
  if (view.nodes.has(invocationId)) return view;
  const placeholderId = plannedInvocationForSubject(view, subject);
  return placeholderId === undefined
    ? view
    : reconcilePlanPlaceholder(view, placeholderId, invocationId);
}

export function reduceRunViewModel(
  view: RunViewModel,
  event: OutputEvent,
): RunViewModel {
  const eventSequence = event.metadata?.sequence ?? view.lastEventSequence + 1;
  const next = {
    ...view,
    lastEventSequence: Math.max(view.lastEventSequence, eventSequence),
  };
  const timestamp = eventTimestamp(event.metadata, view.now);

  switch (event.type) {
    case "run.started":
      return { ...setRunState(next, "active", event), runError: undefined };
    case "run.plan":
      return reducePlan(next, event);
    case "invocation.created":
      return setRunState(reduceCreated(next, event), "active", event);
    case "invocation.started": {
      const started = updateNode(
        materializePlanPlaceholder(next, event.invocationId, event.subject),
        event.invocationId,
        (node) => ({
          ...withState(node, "active", timestamp),
          taskId:
            event.taskId ??
            (event.subject.type === "task"
              ? event.subject.taskId
              : event.subject.type === "validator"
                ? event.subject.validatorId
                : event.subject.planNodeId),
        }),
      );
      return revealAncestors(started, event.invocationId);
    }
    case "invocation.progress":
      return updateNodeDependencies(
        next,
        event.invocationId,
        event.dependencyIds,
        (node) => ({
          ...(isTerminalNodeState(node.state)
            ? node
            : withState(node, event.state, timestamp)),
          ...(event.label === undefined ? {} : { label: event.label }),
          phase: event.phase,
          workspace: event.workspace ?? node.workspace,
          activity: event.message,
          waitingReason: event.waitingReason,
        }),
      );
    case "invocation.activity": {
      return projectActivity(next, event);
    }
    case "invocation.observation":
      return updateNode(next, event.invocationId, (node) => {
        const observations = new Map(node.observations);
        observations.set(
          event.observationId,
          mergeInvocationObservation(
            node.observations.get(event.observationId),
            event,
          ),
        );
        return { ...node, observations };
      });
    case "invocation.output": {
      const node = next.nodes.get(event.invocationId);
      if (node === undefined) return next;
      const priorBytes = outputBytes(node.output);
      const replacedBytes =
        event.policy === "transient"
          ? Buffer.byteLength(node.output.transient ?? "")
          : 0;
      const available = Math.max(
        0,
        Math.min(
          next.limits.nodeDetailBytes - priorBytes + replacedBytes,
          next.limits.runDetailBytes - next.retainedDetailBytes + replacedBytes,
        ),
      );
      const output = retainOutput(node.output, event, available);
      const updated = updateNode(next, event.invocationId, (current) => ({
        ...current,
        output,
      }));
      return {
        ...updated,
        retainedDetailBytes:
          next.retainedDetailBytes - priorBytes + outputBytes(output),
        omittedDetailBytes:
          next.omittedDetailBytes +
          (output.omittedBytes ?? 0) -
          (node.output.omittedBytes ?? 0),
        detailsTruncated: next.detailsTruncated || output.truncated,
      };
    }
    case "invocation.input":
      return updateNode(next, event.invocationId, (node) => ({
        ...node,
        input: event.input,
      }));
    case "invocation.result":
      return updateNode(next, event.invocationId, (node) => ({
        ...node,
        result: event.result,
        ...(node.validation === undefined
          ? {}
          : {
              validation: projectValidationResult(
                event.result,
                node.validation,
              ),
            }),
      }));
    case "invocation.retrying":
      return updateNode(next, event.invocationId, (node) => ({
        ...withState(node, "retrying", timestamp),
        retry: {
          attempt: event.attempt,
          maximumAttempts: event.maximumAttempts,
          delayMs: event.delayMs,
          nextAttemptAt: event.nextAttemptAt,
          lastError: event.lastError,
        },
        failure: undefined,
      }));
    case "invocation.succeeded":
      return updateNode(next, event.invocationId, (node) =>
        withState(node, "succeeded", timestamp),
      );
    case "invocation.failed":
      return revealAncestors(
        updateNode(next, event.invocationId, (node) => ({
          ...withState(node, "failed", timestamp),
          ...(event.error.validation === undefined
            ? {}
            : {
                validation: projectValidationFailure(
                  node.validation,
                  event.error.validation,
                ),
              }),
          failure: {
            category: event.error.category,
            message: event.error.message,
            disposition: event.disposition,
          },
          continuationReason:
            event.disposition === "continue_siblings"
              ? "Execution continued after this failure"
              : undefined,
        })),
        event.invocationId,
      );
    case "invocation.skipped":
      return updateNodeDependencies(
        next,
        event.invocationId,
        event.dependencyIds,
        (node) => ({
          ...withState(node, "skipped", timestamp),
          skipReason: event.reason,
        }),
      );
    case "invocation.cancelled":
      return updateNode(next, event.invocationId, (node) => ({
        ...withState(node, "cancelled", timestamp),
        skipReason: event.reason,
      }));
    case "run.heartbeat":
      return {
        ...next,
        workId: event.workId,
        runId: event.runId,
        lastHeartbeatAt: timestamp,
      };
    case "run.succeeded":
      return setRunState(next, "succeeded", event);
    case "run.failed":
      return {
        ...setRunState(next, "failed", event),
        runError: event.error,
      };
    case "run.cancelled":
      return setRunState(next, "cancelled", event);
  }
  return next;
}

export function reduceRunEvents(
  events: readonly OutputEvent[],
  options: RunViewModelOptions = {},
): RunViewModel {
  return reduceRunEventBatch(createRunViewModel(options), events);
}

function reduceStartedBatch(
  initial: RunViewModel,
  events: readonly Extract<OutputEvent, { type: "invocation.started" }>[],
): RunViewModel {
  const view = reconcileStartedBatch(initial, events);
  const nodes = new Map(view.nodes);
  const presentation = new Map(view.presentation);
  let lastEventSequence = view.lastEventSequence;
  for (const event of events) {
    const eventSequence = event.metadata?.sequence ?? lastEventSequence + 1;
    lastEventSequence = Math.max(lastEventSequence, eventSequence);
    const node = nodes.get(event.invocationId);
    if (node === undefined) continue;
    const timestamp = eventTimestamp(event.metadata, view.now);
    nodes.set(event.invocationId, {
      ...withState(node, "active", timestamp),
      taskId:
        event.taskId ??
        (event.subject.type === "task"
          ? event.subject.taskId
          : event.subject.type === "validator"
            ? event.subject.validatorId
            : event.subject.planNodeId),
    });
    let parentId = node.parentInvocationId;
    while (parentId !== undefined) {
      presentation.set(parentId, { isExpanded: true });
      parentId = nodes.get(parentId)?.parentInvocationId;
    }
  }
  return rebuildTopology({ ...view, presentation, lastEventSequence }, nodes);
}

function collectEventBatch<TType extends OutputEvent["type"]>(
  events: readonly OutputEvent[],
  startIndex: number,
  type: TType,
): {
  readonly batch: Extract<OutputEvent, { type: TType }>[];
  readonly nextIndex: number;
} {
  const batch: Extract<OutputEvent, { type: TType }>[] = [];
  let nextIndex = startIndex;
  while (events[nextIndex]?.type === type) {
    batch.push(events[nextIndex] as Extract<OutputEvent, { type: TType }>);
    nextIndex += 1;
  }
  return { batch, nextIndex };
}

function reduceCreatedBatch(
  view: RunViewModel,
  created: readonly Extract<OutputEvent, { type: "invocation.created" }>[],
): RunViewModel {
  const reconciled = reconcileCreatedBatch(view, created);
  let next: RunViewModel = {
    ...reconciled.view,
    runState: "active" as const,
    workId: created.at(-1)?.workId ?? view.workId,
    runId: created.at(-1)?.runId ?? view.runId,
    startedAt:
      view.startedAt ??
      (created[0] === undefined
        ? undefined
        : eventTimestamp(created[0].metadata, view.now)),
  };
  for (const item of created) {
    if (!reconciled.consumed.has(item.invocationId)) {
      next = reduceRunViewModel(next, item);
      continue;
    }
    const eventSequence = item.metadata?.sequence ?? next.lastEventSequence + 1;
    next = {
      ...next,
      lastEventSequence: Math.max(next.lastEventSequence, eventSequence),
    };
  }
  return next;
}

/** Batch creation bursts so large plans reconcile with one topology rebuild. */
export function reduceRunEventBatch(
  initial: RunViewModel,
  events: readonly OutputEvent[],
): RunViewModel {
  let view = initial;
  for (let index = 0; index < events.length;) {
    const event = events[index];
    if (event?.type === "invocation.started") {
      const { batch: started, nextIndex } = collectEventBatch(
        events,
        index,
        "invocation.started",
      );
      index = nextIndex;
      view =
        started.length === 1 && started[0] !== undefined
          ? reduceRunViewModel(view, started[0])
          : reduceStartedBatch(view, started);
      continue;
    }
    if (event?.type === "invocation.created") {
      const { batch: created, nextIndex } = collectEventBatch(
        events,
        index,
        "invocation.created",
      );
      view = reduceCreatedBatch(view, created);
      index = nextIndex;
      continue;
    }
    if (event !== undefined) {
      view = reduceRunViewModel(view, event);
    }
    index += 1;
  }
  return view;
}

/** Root wall-clock duration. Child durations are intentionally never summed. */
export function getRootRunElapsedMs(
  view: RunViewModel,
  now: Date = view.now(),
): number | undefined {
  const started = timestampMs(view.startedAt);
  if (started === undefined) return undefined;
  const finished = timestampMs(view.finishedAt) ?? now.getTime();
  return Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : undefined;
}

export function getRunVisibleRows(
  view: RunViewModel,
): readonly RunVisibleRow[] {
  const rows: RunVisibleRow[] = [];
  const pending = view.rootInvocationIds
    .map((invocationId, index, roots) => ({
      invocationId,
      depth: 0,
      ancestorRails: [] as readonly boolean[],
      omittedAncestorRailCount: 0,
      hasNextSibling: index < roots.length - 1,
    }))
    .reverse();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const node = view.nodes.get(current.invocationId);
    if (node === undefined) continue;
    const children = view.childrenByParent.get(node.invocationId) ?? [];
    const isExpanded =
      view.presentation.get(node.invocationId)?.isExpanded ?? false;
    rows.push({
      node,
      depth: current.depth,
      ancestorRails: current.ancestorRails,
      omittedAncestorRailCount: current.omittedAncestorRailCount,
      hasChildren: children.length > 0,
      isExpanded,
    });
    if (!isExpanded) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const invocationId = children[index];
      if (invocationId !== undefined) {
        const ancestorRails = [
          ...current.ancestorRails,
          current.hasNextSibling,
        ];
        pending.push({
          invocationId,
          depth: current.depth + 1,
          ancestorRails: ancestorRails.slice(-32),
          omittedAncestorRailCount:
            current.omittedAncestorRailCount +
            Math.max(0, ancestorRails.length - 32),
          hasNextSibling: index < children.length - 1,
        });
      }
    }
  }
  return rows;
}

/** One explicit row prevents bounded projection from looking like a complete run. */
export function getRunProjectionLimitNotice(
  view: RunViewModel,
): string | undefined {
  if (
    view.omittedNodeCount === 0 &&
    view.omittedDependencyEdgeCount === 0 &&
    !view.detailsTruncated
  ) {
    return undefined;
  }
  return (
    "[projection limit: omitted nodes=" +
    view.omittedNodeCount +
    " edges=" +
    view.omittedDependencyEdgeCount +
    (view.detailsTruncated
      ? " details truncated omitted_bytes=" + view.omittedDetailBytes + "]"
      : "]")
  );
}

function revealAncestors(
  view: RunViewModel,
  invocationId: string,
): RunViewModel {
  const presentation = new Map(view.presentation);
  let node = view.nodes.get(invocationId);
  while (node?.parentInvocationId !== undefined) {
    const parent = view.nodes.get(node.parentInvocationId);
    if (parent === undefined) break;
    const current = presentation.get(parent.invocationId) ?? {
      isExpanded: false,
    };
    presentation.set(parent.invocationId, { ...current, isExpanded: true });
    node = parent;
  }
  return { ...view, presentation };
}
