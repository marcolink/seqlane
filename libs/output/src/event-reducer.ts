import { isPlainRecord } from "@seqlane/core";
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
} from "@seqlane/events";
import { isValidationIssue } from "@seqlane/events";

export type OutputEvent = SeqlaneExecutionEvent;

export type HumanValidationVerdict = "passed" | "failed" | "unknown";

export interface HumanValidationState {
  readonly validationNodeId: string;
  readonly sourceId: string;
  readonly sourceType: "validator" | "evaluator" | "validation-gate";
  readonly verdict: HumanValidationVerdict;
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }[];
  readonly evidence?: SeqlaneDisplayValue;
  /** True only when a false repeat-postcondition verdict keeps the loop going. */
  readonly continued: boolean;
}

export type HumanNodeState =
  | "queued"
  | "waiting"
  | "active"
  | "retrying"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface HumanAggregate {
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

export interface HumanOutputState {
  readonly transient?: string;
  readonly persistent: readonly string[];
  readonly metrics?: SeqlaneInvocationMetrics;
  readonly summary?: SeqlaneOutputSummary;
}

export interface HumanRetryState {
  readonly attempt: number;
  readonly maximumAttempts?: number;
  readonly delayMs?: number;
  readonly nextAttemptAt?: string;
  readonly lastError: SerializedSeqlaneError;
}

export interface HumanFailureState {
  readonly category: SerializedSeqlaneError["category"];
  readonly message: string;
  readonly disposition: SeqlaneFailureDisposition;
}

export interface HumanPresentationState {
  readonly isExpanded: boolean;
  readonly isFocused: boolean;
}

export interface HumanExecutionNode {
  readonly invocationId: string;
  readonly taskId: string;
  readonly kind: SeqlaneInvocationKind;
  readonly label: string;
  readonly parentInvocationId?: string;
  readonly iteration?: number;
  readonly siblingOrder: number;
  readonly dependencyIds: readonly string[];
  readonly waitingDependencyLabels: readonly string[];
  readonly state: HumanNodeState;
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
  readonly phase?: string;
  readonly activity?: string;
  readonly waitingReason?: string;
  readonly aggregate: HumanAggregate;
  readonly output: HumanOutputState;
  readonly validation?: HumanValidationState;
  readonly retry?: HumanRetryState;
  readonly failure?: HumanFailureState;
  readonly skipReason?: string;
  readonly continuationReason?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly elapsedMs?: number;
  readonly presentation: HumanPresentationState;
  readonly createdSequence: number;
}

export type HumanRunState =
  "idle" | "active" | "succeeded" | "failed" | "cancelled";

export interface HumanExecutionViewModel {
  readonly workId?: string;
  readonly runId?: string;
  readonly runState: HumanRunState;
  readonly runError?: SerializedSeqlaneError;
  readonly nodes: ReadonlyMap<string, HumanExecutionNode>;
  readonly rootInvocationIds: readonly string[];
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
  readonly lastHeartbeatAt?: string;
  readonly lastEventSequence: number;
  readonly now: () => Date;
}

export interface HumanViewModelOptions {
  readonly now?: () => Date;
}

export interface HumanVisibleRow {
  readonly node: HumanExecutionNode;
  readonly depth: number;
  readonly hasChildren: boolean;
}

const EMPTY_AGGREGATE: HumanAggregate = {
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
  expandedByDefault: boolean,
): HumanExecutionNode {
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
    presentation: {
      isExpanded: expandedByDefault,
      isFocused: false,
    },
    createdSequence,
  };
}

function projectValidationResult(
  display: SeqlaneDisplayValue,
  current: HumanValidationState,
): HumanValidationState {
  if (display.state !== "present" || !isPlainRecord(display.value)) {
    return { ...current, verdict: "unknown", issues: [], evidence: undefined };
  }
  const success = display.value.success;
  const issues = display.value.issues;
  if (
    typeof success !== "boolean" ||
    (success === false &&
      (!Array.isArray(issues) || !issues.every(isValidationIssue)))
  ) {
    return { ...current, verdict: "unknown", issues: [], evidence: undefined };
  }
  const evidence = display.value.evidence;
  return {
    ...current,
    verdict: success ? "passed" : "failed",
    issues: success ? [] : (issues as HumanValidationState["issues"]),
    ...(evidence === undefined
      ? { evidence: undefined }
      : { evidence: { state: "present", value: evidence } }),
    continued: !success && current.sourceType === "validation-gate",
  };
}

function projectValidationFailure(
  current: HumanValidationState | undefined,
  validation: NonNullable<SerializedSeqlaneError["validation"]>,
): HumanValidationState {
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
  view: HumanExecutionViewModel,
  invocationId: string,
  update: (node: HumanExecutionNode) => HumanExecutionNode,
): HumanExecutionViewModel {
  const current = view.nodes.get(invocationId);
  if (current === undefined) return view;
  const nodes = new Map(view.nodes);
  nodes.set(invocationId, update(current));
  return derive(view, nodes);
}

function withState(
  node: HumanExecutionNode,
  state: HumanNodeState,
  timestamp: string,
): HumanExecutionNode {
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

function isTerminalNodeState(state: HumanNodeState): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

function descendants(
  nodes: ReadonlyMap<string, HumanExecutionNode>,
  parentInvocationId: string,
): HumanExecutionNode[] {
  const children = [...nodes.values()]
    .filter((node) => node.parentInvocationId === parentInvocationId)
    .sort(compareNodes);
  return children.flatMap((child) => [
    child,
    ...descendants(nodes, child.invocationId),
  ]);
}

function compareNodes(
  left: HumanExecutionNode,
  right: HumanExecutionNode,
): number {
  return (
    left.siblingOrder - right.siblingOrder ||
    left.createdSequence - right.createdSequence ||
    left.invocationId.localeCompare(right.invocationId)
  );
}

function aggregateFor(
  node: HumanExecutionNode,
  nodes: ReadonlyMap<string, HumanExecutionNode>,
): HumanAggregate {
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
  view: HumanExecutionViewModel,
  sourceNodes: ReadonlyMap<string, HumanExecutionNode>,
): HumanExecutionViewModel {
  const nodes = new Map<string, HumanExecutionNode>();
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

export function createHumanViewModel(
  options: HumanViewModelOptions = {},
): HumanExecutionViewModel {
  const view: HumanExecutionViewModel = {
    runState: "idle",
    nodes: new Map(),
    rootInvocationIds: [],
    toolUsage: new Map(),
    skillUsage: new Map(),
    lastEventSequence: 0,
    now: options.now ?? (() => new Date()),
  };
  return derive(view, view.nodes);
}

function setRunState(
  view: HumanExecutionViewModel,
  runState: HumanRunState,
  event: OutputEvent,
): HumanExecutionViewModel {
  return {
    ...view,
    workId: "workId" in event ? event.workId : view.workId,
    runId: "runId" in event ? event.runId : view.runId,
    runState,
  };
}

function reduceCreated(
  view: HumanExecutionViewModel,
  event: Extract<OutputEvent, { type: "invocation.created" }>,
): HumanExecutionViewModel {
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
  nodes.set(
    event.invocationId,
    emptyNode(
      event,
      view.lastEventSequence,
      event.kind === "workflow" || event.kind === "loop",
    ),
  );
  return derive(view, nodes);
}

export function reduceHumanViewModel(
  view: HumanExecutionViewModel,
  event: OutputEvent,
): HumanExecutionViewModel {
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

export function reduceHumanEvents(
  events: readonly OutputEvent[],
  options: HumanViewModelOptions = {},
): HumanExecutionViewModel {
  return events.reduce(reduceHumanViewModel, createHumanViewModel(options));
}

function childrenOf(
  view: HumanExecutionViewModel,
  parentInvocationId: string,
): HumanExecutionNode[] {
  return [...view.nodes.values()]
    .filter((node) => node.parentInvocationId === parentInvocationId)
    .sort(compareNodes);
}

export function getHumanVisibleRows(
  view: HumanExecutionViewModel,
): readonly HumanVisibleRow[] {
  const rows: HumanVisibleRow[] = [];
  const visit = (invocationId: string, depth: number): void => {
    const node = view.nodes.get(invocationId);
    if (node === undefined) return;
    const children = childrenOf(view, invocationId);
    rows.push({ node, depth, hasChildren: children.length > 0 });
    if (!node.presentation.isExpanded) return;
    for (const child of children) visit(child.invocationId, depth + 1);
  };
  for (const rootInvocationId of view.rootInvocationIds) {
    visit(rootInvocationId, 0);
  }
  return rows;
}

export function setHumanNodeExpanded(
  view: HumanExecutionViewModel,
  invocationId: string,
  isExpanded: boolean,
): HumanExecutionViewModel {
  return updateNode(view, invocationId, (node) => ({
    ...node,
    presentation: { ...node.presentation, isExpanded },
  }));
}

export function setHumanNodeFocused(
  view: HumanExecutionViewModel,
  invocationId: string | undefined,
): HumanExecutionViewModel {
  const nodes = new Map<string, HumanExecutionNode>();
  for (const node of view.nodes.values()) {
    nodes.set(node.invocationId, {
      ...node,
      presentation: {
        ...node.presentation,
        isFocused: node.invocationId === invocationId,
      },
    });
  }
  return derive(view, nodes);
}
