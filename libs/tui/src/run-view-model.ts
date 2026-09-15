import { validationResultSchema } from "@seqlane/core";
import type {
  SeqlaneFailureDisposition,
  SeqlaneDisplayValue,
  SeqlaneInvocationKind,
  SeqlaneInvocationMetrics,
  SeqlaneOutputSummary,
} from "@seqlane/core";
import type {
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
  readonly isFocused: boolean;
  /** User choices outrank automatic active/successful branch presentation. */
  readonly isManuallyExpanded?: boolean;
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
  readonly phase?: string;
  readonly activity?: string;
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
  readonly workId?: string;
  readonly runId?: string;
  readonly runState: RunState;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly runError?: SerializedSeqlaneError;
  readonly nodes: ReadonlyMap<string, RunNode>;
  /** Stable containment index. Normal event updates do not rebuild it. */
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
  /** User-controlled state kept separate from the event-derived execution nodes. */
  readonly presentation: ReadonlyMap<string, RunPresentationState>;
  readonly rootInvocationIds: readonly string[];
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
  readonly lastHeartbeatAt?: string;
  readonly lastEventSequence: number;
  readonly limits: RunProjectionLimits;
  readonly omittedNodeCount: number;
  readonly omittedDependencyEdgeCount: number;
  readonly retainedDetailBytes: number;
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
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
}

const EMPTY_AGGREGATE: RunAggregate = {
  total: 0,
  queued: 0,
  waiting: 0,
  active: 0,
  retrying: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Keep a UTF-8 prefix and report exactly what was omitted. */
function truncateDetailText(value: string, limit: number): string {
  const originalBytes = byteLength(value);
  if (originalBytes <= limit) return value;
  const marker = `[truncated original_bytes=${originalBytes}]`;
  // A visible truncation marker is more important than an impossible tiny
  // storage budget. This still retains no raw event payload.
  if (limit <= marker.length) return marker;
  const prefixBytes = limit - byteLength(marker);
  let end = value.length;
  while (byteLength(value.slice(0, end)) > prefixBytes) end -= 1;
  return value.slice(0, end) + marker;
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
  const nodes = new Map(view.nodes);
  const waitingDependencyLabels = updated.dependencyIds
    .map((dependencyId) => nodes.get(dependencyId)?.label)
    .filter((label): label is string => label !== undefined);
  nodes.set(
    invocationId,
    updated.kind === "workflow" || updated.kind === "loop"
      ? { ...updated, waitingDependencyLabels }
      : {
          ...updated,
          waitingDependencyLabels,
          aggregate: aggregateForNode(updated),
        },
  );
  return applyAncestorAggregateDelta(
    { ...view, nodes },
    aggregateDelta(aggregateForNode(updated), aggregateForNode(current)),
    updated.parentInvocationId,
  );
}

function withState(
  node: RunNode,
  state: RunNodeState,
  timestamp: string,
): RunNode {
  const startedAt = node.startedAt ?? timestamp;
  const terminal =
    state === "succeeded" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled";
  return {
    ...node,
    state,
    startedAt,
    ...(terminal
      ? {
          finishedAt: timestamp,
          elapsedMs: elapsedBetween(startedAt, timestamp),
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

function compareNodes(left: RunNode, right: RunNode): number {
  return (
    left.siblingOrder - right.siblingOrder ||
    left.createdSequence - right.createdSequence ||
    left.invocationId.localeCompare(right.invocationId)
  );
}

function aggregateForNode(node: Pick<RunNode, "state">): RunAggregate {
  return {
    total: 1,
    queued: node.state === "queued" ? 1 : 0,
    waiting: node.state === "waiting" ? 1 : 0,
    active: node.state === "active" ? 1 : 0,
    retrying: node.state === "retrying" ? 1 : 0,
    succeeded: node.state === "succeeded" ? 1 : 0,
    failed: node.state === "failed" ? 1 : 0,
    skipped: node.state === "skipped" ? 1 : 0,
    cancelled: node.state === "cancelled" ? 1 : 0,
  };
}

function aggregateDelta(
  next: RunAggregate,
  previous: RunAggregate,
): RunAggregate {
  return {
    total: next.total - previous.total,
    queued: next.queued - previous.queued,
    waiting: next.waiting - previous.waiting,
    active: next.active - previous.active,
    retrying: next.retrying - previous.retrying,
    succeeded: next.succeeded - previous.succeeded,
    failed: next.failed - previous.failed,
    skipped: next.skipped - previous.skipped,
    cancelled: next.cancelled - previous.cancelled,
  };
}

function addAggregate(
  aggregate: RunAggregate,
  delta: RunAggregate,
): RunAggregate {
  return {
    total: aggregate.total + delta.total,
    queued: aggregate.queued + delta.queued,
    waiting: aggregate.waiting + delta.waiting,
    active: aggregate.active + delta.active,
    retrying: aggregate.retrying + delta.retrying,
    succeeded: aggregate.succeeded + delta.succeeded,
    failed: aggregate.failed + delta.failed,
    skipped: aggregate.skipped + delta.skipped,
    cancelled: aggregate.cancelled + delta.cancelled,
  };
}

function isEmptyAggregate(aggregate: RunAggregate): boolean {
  return Object.values(aggregate).every((value) => value === 0);
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

function rebuildTopology(
  view: RunViewModel,
  sourceNodes: ReadonlyMap<string, RunNode>,
): RunViewModel {
  const childrenByParent = new Map<string, string[]>();
  for (const node of sourceNodes.values()) {
    if (node.parentInvocationId === undefined) continue;
    const children = childrenByParent.get(node.parentInvocationId) ?? [];
    children.push(node.invocationId);
    childrenByParent.set(node.parentInvocationId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((leftId, rightId) => {
      const left = sourceNodes.get(leftId);
      const right = sourceNodes.get(rightId);
      return left === undefined || right === undefined
        ? 0
        : compareNodes(left, right);
    });
  }
  const nodes = new Map<string, RunNode>();
  for (const node of sourceNodes.values()) {
    nodes.set(node.invocationId, {
      ...node,
      waitingDependencyLabels: node.dependencyIds
        .map((dependencyId) => sourceNodes.get(dependencyId)?.label)
        .filter((label): label is string => label !== undefined),
      aggregate:
        node.kind === "workflow" || node.kind === "loop"
          ? EMPTY_AGGREGATE
          : aggregateForNode(node),
    });
  }
  const rootInvocationIds = [...nodes.values()]
    .filter(
      (node) =>
        node.parentInvocationId === undefined ||
        !nodes.has(node.parentInvocationId),
    )
    .sort(compareNodes)
    .map(({ invocationId }) => invocationId);
  let rebuilt: RunViewModel = {
    ...view,
    nodes,
    childrenByParent,
    rootInvocationIds,
  };
  for (const node of nodes.values()) {
    rebuilt = applyAncestorAggregateDelta(
      rebuilt,
      aggregateForNode(node),
      node.parentInvocationId,
    );
  }
  return rebuilt;
}

export function createRunViewModel(
  options: RunViewModelOptions = {},
): RunViewModel {
  const view: RunViewModel = {
    runState: "idle",
    nodes: new Map(),
    childrenByParent: new Map(),
    presentation: new Map(),
    rootInvocationIds: [],
    toolUsage: new Map(),
    skillUsage: new Map(),
    lastEventSequence: 0,
    limits: { ...DEFAULT_RUN_PROJECTION_LIMITS, ...options.limits },
    omittedNodeCount: 0,
    omittedDependencyEdgeCount: 0,
    retainedDetailBytes: 0,
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

function addChildToTopology(
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  nodes: ReadonlyMap<string, RunNode>,
  node: RunNode,
): ReadonlyMap<string, readonly string[]> {
  if (node.parentInvocationId === undefined) return childrenByParent;
  const next = new Map(childrenByParent);
  const children = [
    ...(next.get(node.parentInvocationId) ?? []),
    node.invocationId,
  ];
  children.sort((leftId, rightId) => {
    const left = nodes.get(leftId);
    const right = nodes.get(rightId);
    return left === undefined || right === undefined
      ? 0
      : compareNodes(left, right);
  });
  next.set(node.parentInvocationId, children);
  return next;
}

function rootInvocationIds(
  nodes: ReadonlyMap<string, RunNode>,
): readonly string[] {
  return [...nodes.values()]
    .filter(
      (node) =>
        node.parentInvocationId === undefined ||
        !nodes.has(node.parentInvocationId),
    )
    .sort(compareNodes)
    .map(({ invocationId }) => invocationId);
}

function reduceCreated(
  view: RunViewModel,
  event: Extract<OutputEvent, { type: "invocation.created" }>,
): RunViewModel {
  const placeholderId = [...view.nodes.values()].find(
    (node) =>
      node.planNodeId === event.planNodeId &&
      node.invocationId.startsWith("plan:"),
  )?.invocationId;
  if (placeholderId !== undefined) {
    const nodes = new Map(view.nodes);
    nodes.delete(placeholderId);
    const presentation = new Map(view.presentation);
    presentation.delete(placeholderId);
    return reduceCreated(
      rebuildTopology({ ...view, presentation }, nodes),
      event,
    );
  }
  const remainingEdges =
    view.limits.dependencyEdges -
    [...view.nodes.values()].reduce(
      (count, node) => count + node.dependencyIds.length,
      0,
    );
  const dependencyIds = boundedDependencies(
    event.dependencyIds,
    remainingEdges,
  );
  const omittedEdges = event.dependencyIds.length - dependencyIds.length;
  const existing = view.nodes.get(event.invocationId);
  if (existing !== undefined) {
    const nodes = new Map(view.nodes);
    nodes.set(event.invocationId, {
      ...existing,
      label: event.label,
      kind: event.kind,
      parentInvocationId: event.parentInvocationId,
      ...(event.iteration === undefined
        ? { iteration: undefined }
        : { iteration: event.iteration }),
      siblingOrder: event.siblingOrder,
      dependencyIds,
    });
    return rebuildTopology(
      {
        ...view,
        omittedDependencyEdgeCount:
          view.omittedDependencyEdgeCount + omittedEdges,
      },
      nodes,
    );
  }
  if (view.nodes.size >= view.limits.nodes) {
    return {
      ...view,
      omittedNodeCount: view.omittedNodeCount + 1,
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
    isFocused: false,
  });
  const next = {
    ...view,
    nodes,
    childrenByParent: addChildToTopology(view.childrenByParent, nodes, node),
    rootInvocationIds: rootInvocationIds(nodes),
    presentation,
    omittedDependencyEdgeCount: view.omittedDependencyEdgeCount + omittedEdges,
  };
  return applyAncestorAggregateDelta(
    next,
    aggregateForNode(node),
    node.parentInvocationId,
  );
}

function planNodeKind(
  node: Extract<OutputEvent, { type: "run.plan" }>["plan"]["nodes"][number],
): RunNode["kind"] {
  if (node.type === "workflow") return "workflow";
  if (node.type === "repeat") return "loop";
  if (node.type.startsWith("validation.")) return "validation";
  return "task";
}

function planNodeSubject(
  node: Extract<OutputEvent, { type: "run.plan" }>["plan"]["nodes"][number],
): Extract<OutputEvent, { type: "invocation.created" }>["subject"] {
  if (node.type === "task" && node.taskId !== undefined) {
    return { type: "task", taskId: node.taskId };
  }
  return { type: "validation-gate", planNodeId: node.planNodeId };
}

function reducePlan(
  view: RunViewModel,
  event: Extract<OutputEvent, { type: "run.plan" }>,
): RunViewModel {
  let projected = view;
  for (const node of event.plan.nodes) {
    if (
      [...projected.nodes.values()].some(
        (current) => current.planNodeId === node.planNodeId,
      )
    ) {
      continue;
    }
    const created: Extract<OutputEvent, { type: "invocation.created" }> = {
      type: "invocation.created",
      metadata: event.metadata,
      workId: event.workId,
      runId: event.runId,
      invocationId: `plan:${node.planNodeId}`,
      planNodeId: node.planNodeId,
      subject: planNodeSubject(node),
      ...(node.taskId === undefined ? {} : { taskId: node.taskId }),
      kind: planNodeKind(node),
      label: node.label,
      ...(node.parentPlanNodeId === undefined
        ? {}
        : { parentInvocationId: `plan:${node.parentPlanNodeId}` }),
      siblingOrder: node.siblingOrder,
      dependencyIds: node.dependsOn.map((id) => `plan:${id}`),
    };
    projected = reduceCreated(projected, created);
  }
  return setRunState(projected, "active", event);
}

function collapseSuccessfulBranch(
  view: RunViewModel,
  invocationId: string,
): RunViewModel {
  const node = view.nodes.get(invocationId);
  const state = view.presentation.get(invocationId);
  if (
    node === undefined ||
    (node.kind !== "workflow" && node.kind !== "loop") ||
    state?.isManuallyExpanded
  ) {
    return view;
  }
  const presentation = new Map(view.presentation);
  presentation.set(invocationId, {
    isExpanded: false,
    isFocused: state?.isFocused ?? false,
  });
  return { ...view, presentation };
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
      const started = updateNode(next, event.invocationId, (node) => ({
        ...withState(node, "active", timestamp),
        taskId:
          event.taskId ??
          (event.subject.type === "task"
            ? event.subject.taskId
            : event.subject.type === "validator"
              ? event.subject.validatorId
              : event.subject.planNodeId),
      }));
      return focusedInvocationId(started) === undefined
        ? setRunNodeFocused(started, event.invocationId)
        : started;
    }
    case "invocation.progress":
      return updateNode(next, event.invocationId, (node) => ({
        ...(isTerminalNodeState(node.state)
          ? node
          : withState(node, event.state, timestamp)),
        ...(event.label === undefined ? {} : { label: event.label }),
        phase: event.phase,
        activity: event.message,
        waitingReason: event.waitingReason,
        dependencyIds: event.dependencyIds ?? node.dependencyIds,
      }));
    case "invocation.activity": {
      const usage =
        event.kind === "skill"
          ? new Map(next.skillUsage)
          : new Map(next.toolUsage);
      usage.set(event.name, (usage.get(event.name) ?? 0) + 1);
      const nextView =
        event.kind === "skill"
          ? { ...next, skillUsage: usage }
          : { ...next, toolUsage: usage };
      return updateNode(nextView, event.invocationId, (node) => {
        const nodeUsage =
          event.kind === "skill"
            ? new Map(node.skillUsage)
            : new Map(node.toolUsage);
        nodeUsage.set(event.name, (nodeUsage.get(event.name) ?? 0) + 1);
        return {
          ...node,
          ...(event.kind === "skill"
            ? { skillUsage: nodeUsage }
            : { toolUsage: nodeUsage }),
          activity: event.kind + " " + event.name + " " + event.state,
        };
      });
    }
    case "invocation.output": {
      const node = next.nodes.get(event.invocationId);
      if (node === undefined) return next;
      const priorNodeBytes =
        (node.output.transient === undefined
          ? 0
          : byteLength(node.output.transient)) +
        node.output.persistent.reduce(
          (total, output) => total + byteLength(output),
          0,
        );
      const replacedTransientBytes =
        event.policy === "transient" && node.output.transient !== undefined
          ? byteLength(node.output.transient)
          : 0;
      const available = Math.max(
        0,
        Math.min(
          next.limits.nodeDetailBytes - priorNodeBytes,
          next.limits.runDetailBytes -
            (next.retainedDetailBytes - replacedTransientBytes),
        ),
      );
      const content = truncateDetailText(event.content, available);
      const retainedBytes = byteLength(content);
      const updated = updateNode(next, event.invocationId, (node) => ({
        ...node,
        output:
          event.policy === "persistent"
            ? {
                transient: node.output.transient,
                persistent: [...node.output.persistent, content],
                ...(event.metrics === undefined
                  ? node.output.metrics === undefined
                    ? {}
                    : { metrics: node.output.metrics }
                  : { metrics: event.metrics }),
                ...(event.summary === undefined
                  ? node.output.summary === undefined
                    ? {}
                    : { summary: node.output.summary }
                  : { summary: event.summary }),
              }
            : {
                ...node.output,
                transient: content,
                ...(event.metrics === undefined
                  ? {}
                  : { metrics: event.metrics }),
                ...(event.summary === undefined
                  ? {}
                  : { summary: event.summary }),
              },
      }));
      return {
        ...updated,
        retainedDetailBytes:
          next.retainedDetailBytes - replacedTransientBytes + retainedBytes,
      };
    }
    case "invocation.input":
      return next;
    case "invocation.result":
      return updateNode(next, event.invocationId, (node) =>
        node.validation === undefined
          ? node
          : {
              ...node,
              validation: projectValidationResult(
                event.result,
                node.validation,
              ),
            },
      );
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
      return collapseSuccessfulBranch(
        updateNode(next, event.invocationId, (node) =>
          withState(node, "succeeded", timestamp),
        ),
        event.invocationId,
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
      return updateNode(next, event.invocationId, (node) => ({
        ...withState(node, "skipped", timestamp),
        skipReason: event.reason,
        dependencyIds: event.dependencyIds ?? node.dependencyIds,
      }));
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
  return events.reduce(reduceRunViewModel, createRunViewModel(options));
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
      hasChildren: children.length > 0,
      isExpanded,
    });
    if (!isExpanded) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const invocationId = children[index];
      if (invocationId !== undefined) {
        pending.push({
          invocationId,
          depth: current.depth + 1,
          ancestorRails: [...current.ancestorRails, current.hasNextSibling],
          hasNextSibling: index < children.length - 1,
        });
      }
    }
  }
  return rows;
}

/**
 * Select a stable window which always contains the focused row. The viewport
 * is derived, so resize never mutates focus or the user's expansion choices.
 */
export function getRunViewportRows(
  view: RunViewModel,
  maxRows: number,
): readonly RunVisibleRow[] {
  const rows = getRunVisibleRows(view);
  if (maxRows <= 0 || rows.length <= maxRows) return rows;
  const focused = focusedInvocationId(view);
  const focusedIndex = rows.findIndex(
    (row) => row.node.invocationId === focused,
  );
  const centeredStart = Math.max(0, focusedIndex - Math.floor(maxRows / 2));
  const start = Math.min(centeredStart, rows.length - maxRows);
  return rows.slice(start, start + maxRows);
}

/** One explicit row prevents bounded projection from looking like a complete run. */
export function getRunProjectionLimitNotice(
  view: RunViewModel,
): string | undefined {
  if (view.omittedNodeCount === 0 && view.omittedDependencyEdgeCount === 0) {
    return undefined;
  }
  return (
    "[projection limit: omitted nodes=" +
    view.omittedNodeCount +
    " edges=" +
    view.omittedDependencyEdgeCount +
    "]"
  );
}

export function setRunNodeExpanded(
  view: RunViewModel,
  invocationId: string,
  isExpanded: boolean,
): RunViewModel {
  if (!view.nodes.has(invocationId)) return view;
  const presentation = new Map(view.presentation);
  const current = presentation.get(invocationId) ?? {
    isExpanded: false,
    isFocused: false,
  };
  presentation.set(invocationId, {
    ...current,
    isExpanded,
    isManuallyExpanded: true,
  });
  return { ...view, presentation };
}

export function setRunNodeFocused(
  view: RunViewModel,
  invocationId: string | undefined,
): RunViewModel {
  const presentation = new Map<string, RunPresentationState>();
  for (const node of view.nodes.values()) {
    const current = view.presentation.get(node.invocationId) ?? {
      isExpanded: false,
      isFocused: false,
    };
    presentation.set(node.invocationId, {
      ...current,
      isFocused: node.invocationId === invocationId,
    });
  }
  return { ...view, presentation };
}

function focusedInvocationId(view: RunViewModel): string | undefined {
  for (const [invocationId, presentation] of view.presentation) {
    if (presentation.isFocused && view.nodes.has(invocationId)) {
      return invocationId;
    }
  }
  return undefined;
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
      isFocused: false,
    };
    presentation.set(parent.invocationId, { ...current, isExpanded: true });
    node = parent;
  }
  return { ...view, presentation };
}

/** Move focus by a visible-row offset without modifying execution state. */
export function moveRunNodeFocus(
  view: RunViewModel,
  direction: -1 | 1,
): RunViewModel {
  const rows = getRunVisibleRows(view);
  if (rows.length === 0) return view;
  const current = focusedInvocationId(view);
  const index = rows.findIndex(({ node }) => node.invocationId === current);
  const nextIndex = Math.max(0, Math.min(rows.length - 1, index + direction));
  return setRunNodeFocused(view, rows[nextIndex]?.node.invocationId);
}

/** Collapse the focused branch, or focus its parent when already collapsed. */
export function collapseOrFocusParent(view: RunViewModel): RunViewModel {
  const focused = focusedInvocationId(view);
  if (focused === undefined) return view;
  const node = view.nodes.get(focused);
  if (node === undefined) return view;
  const children = view.childrenByParent.get(focused) ?? [];
  const expanded = view.presentation.get(focused)?.isExpanded ?? false;
  if (children.length > 0 && expanded)
    return setRunNodeExpanded(view, focused, false);
  return setRunNodeFocused(view, node.parentInvocationId);
}

/** Expand the focused branch, or focus its first child when already expanded. */
export function expandOrFocusChild(view: RunViewModel): RunViewModel {
  const focused = focusedInvocationId(view);
  if (focused === undefined) return view;
  const children = view.childrenByParent.get(focused) ?? [];
  if (children.length === 0) return view;
  const expanded = view.presentation.get(focused)?.isExpanded ?? false;
  if (!expanded) return setRunNodeExpanded(view, focused, true);
  return setRunNodeFocused(view, children[0]);
}

/** Focus the next failed row and reveal the containment path that leads to it. */
export function focusNextFailedRunNode(view: RunViewModel): RunViewModel {
  const failures = [...view.nodes.values()]
    .filter((node) => node.state === "failed")
    .sort(compareNodes);
  if (failures.length === 0) return view;
  const focused = focusedInvocationId(view);
  const currentIndex = failures.findIndex(
    (node) => node.invocationId === focused,
  );
  const next = failures[(currentIndex + 1) % failures.length];
  if (next === undefined) return view;
  return setRunNodeFocused(
    revealAncestors(view, next.invocationId),
    next.invocationId,
  );
}
