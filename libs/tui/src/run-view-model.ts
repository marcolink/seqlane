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
}

export interface RunNode {
  readonly invocationId: string;
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
  readonly runError?: SerializedSeqlaneError;
  readonly nodes: ReadonlyMap<string, RunNode>;
  /** User-controlled state kept separate from the event-derived execution nodes. */
  readonly presentation: ReadonlyMap<string, RunPresentationState>;
  readonly rootInvocationIds: readonly string[];
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
  readonly lastHeartbeatAt?: string;
  readonly lastEventSequence: number;
  readonly now: () => Date;
}

export interface RunViewModelOptions {
  readonly now?: () => Date;
}

export interface RunVisibleRow {
  readonly node: RunNode;
  readonly depth: number;
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
    taskId,
    kind: event.kind,
    label: event.label,
    ...(event.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: event.parentInvocationId }),
    ...(event.iteration === undefined ? {} : { iteration: event.iteration }),
    siblingOrder: event.siblingOrder,
    dependencyIds: [...event.dependencyIds],
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
  const nodes = new Map(view.nodes);
  nodes.set(invocationId, update(current));
  return derive(view, nodes);
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

function descendants(
  nodes: ReadonlyMap<string, RunNode>,
  parentInvocationId: string,
): RunNode[] {
  const children = [...nodes.values()]
    .filter((node) => node.parentInvocationId === parentInvocationId)
    .sort(compareNodes);
  return children.flatMap((child) => [
    child,
    ...descendants(nodes, child.invocationId),
  ]);
}

function compareNodes(left: RunNode, right: RunNode): number {
  return (
    left.siblingOrder - right.siblingOrder ||
    left.createdSequence - right.createdSequence ||
    left.invocationId.localeCompare(right.invocationId)
  );
}

function aggregateFor(
  node: RunNode,
  nodes: ReadonlyMap<string, RunNode>,
): RunAggregate {
  const members =
    node.kind === "workflow" || node.kind === "loop"
      ? descendants(nodes, node.invocationId)
      : [node];
  return members.reduce(
    (aggregate, member) => ({
      total: aggregate.total + 1,
      queued: aggregate.queued + (member.state === "queued" ? 1 : 0),
      waiting: aggregate.waiting + (member.state === "waiting" ? 1 : 0),
      active: aggregate.active + (member.state === "active" ? 1 : 0),
      retrying: aggregate.retrying + (member.state === "retrying" ? 1 : 0),
      succeeded: aggregate.succeeded + (member.state === "succeeded" ? 1 : 0),
      failed: aggregate.failed + (member.state === "failed" ? 1 : 0),
      skipped: aggregate.skipped + (member.state === "skipped" ? 1 : 0),
      cancelled: aggregate.cancelled + (member.state === "cancelled" ? 1 : 0),
    }),
    EMPTY_AGGREGATE,
  );
}

function derive(
  view: RunViewModel,
  sourceNodes: ReadonlyMap<string, RunNode>,
): RunViewModel {
  const nodes = new Map<string, RunNode>();
  for (const node of sourceNodes.values()) {
    nodes.set(node.invocationId, {
      ...node,
      waitingDependencyLabels: node.dependencyIds
        .map((dependencyId) => sourceNodes.get(dependencyId)?.label)
        .filter((label): label is string => label !== undefined),
      aggregate: aggregateFor(node, sourceNodes),
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
  return { ...view, nodes, rootInvocationIds };
}

export function createRunViewModel(
  options: RunViewModelOptions = {},
): RunViewModel {
  const view: RunViewModel = {
    runState: "idle",
    nodes: new Map(),
    presentation: new Map(),
    rootInvocationIds: [],
    toolUsage: new Map(),
    skillUsage: new Map(),
    lastEventSequence: 0,
    now: options.now ?? (() => new Date()),
  };
  return derive(view, view.nodes);
}

function setRunState(
  view: RunViewModel,
  runState: RunState,
  event: OutputEvent,
): RunViewModel {
  return {
    ...view,
    workId: "workId" in event ? event.workId : view.workId,
    runId: "runId" in event ? event.runId : view.runId,
    runState,
  };
}

function reduceCreated(
  view: RunViewModel,
  event: Extract<OutputEvent, { type: "invocation.created" }>,
): RunViewModel {
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
      dependencyIds: [...event.dependencyIds],
    });
    return derive(view, nodes);
  }
  const nodes = new Map(view.nodes);
  nodes.set(event.invocationId, emptyNode(event, view.lastEventSequence));
  const presentation = new Map(view.presentation);
  presentation.set(event.invocationId, {
    isExpanded: event.kind === "workflow" || event.kind === "loop",
    isFocused: false,
  });
  return derive({ ...view, presentation }, nodes);
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
      return next;
    case "invocation.created":
      return setRunState(reduceCreated(next, event), "active", event);
    case "invocation.started":
      return updateNode(next, event.invocationId, (node) => ({
        ...withState(node, "active", timestamp),
        taskId:
          event.taskId ??
          (event.subject.type === "task"
            ? event.subject.taskId
            : event.subject.type === "validator"
              ? event.subject.validatorId
              : event.subject.planNodeId),
      }));
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
    case "invocation.output":
      return updateNode(next, event.invocationId, (node) => ({
        ...node,
        output:
          event.policy === "persistent"
            ? {
                transient: node.output.transient,
                persistent: [...node.output.persistent, event.content],
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
                transient: event.content,
                ...(event.metrics === undefined
                  ? {}
                  : { metrics: event.metrics }),
                ...(event.summary === undefined
                  ? {}
                  : { summary: event.summary }),
              },
      }));
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
      return updateNode(next, event.invocationId, (node) =>
        withState(node, "succeeded", timestamp),
      );
    case "invocation.failed":
      return updateNode(next, event.invocationId, (node) => ({
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
      }));
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

function childrenOf(view: RunViewModel, parentInvocationId: string): RunNode[] {
  return [...view.nodes.values()]
    .filter((node) => node.parentInvocationId === parentInvocationId)
    .sort(compareNodes);
}

export function getRunVisibleRows(
  view: RunViewModel,
): readonly RunVisibleRow[] {
  const rows: RunVisibleRow[] = [];
  const visit = (invocationId: string, depth: number): void => {
    const node = view.nodes.get(invocationId);
    if (node === undefined) return;
    const children = childrenOf(view, invocationId);
    const isExpanded =
      view.presentation.get(node.invocationId)?.isExpanded ?? false;
    rows.push({ node, depth, hasChildren: children.length > 0, isExpanded });
    if (!isExpanded) return;
    for (const child of children) visit(child.invocationId, depth + 1);
  };
  for (const rootInvocationId of view.rootInvocationIds) {
    visit(rootInvocationId, 0);
  }
  return rows;
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
  presentation.set(invocationId, { ...current, isExpanded });
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
