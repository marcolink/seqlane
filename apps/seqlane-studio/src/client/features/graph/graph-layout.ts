import type { Edge, Node, XYPosition } from "@xyflow/react";
import type {
  StudioInvocationSnapshot,
  StudioInvocationState,
  StudioPlanNodeSnapshot,
  StudioRunSnapshot,
} from "@seqlane/studio/protocol";
import {
  invocationContextMap,
  type InvocationDisplayContext,
} from "../invocations/invocation-context.js";

export interface StudioPlanGraphData extends Record<string, unknown> {
  readonly kind: "plan";
  readonly planNode: StudioPlanNodeSnapshot;
  readonly invocations: readonly StudioInvocationSnapshot[];
  readonly invocationContexts: ReadonlyMap<string, InvocationDisplayContext>;
  readonly onSelectInvocation?: (invocationId: string) => void;
  readonly selectedInvocationId?: string;
}

export interface StudioInvocationGraphData extends Record<string, unknown> {
  readonly kind: "invocation";
  readonly invocation: StudioInvocationSnapshot;
  readonly context: InvocationDisplayContext;
}

export type StudioGraphData = StudioPlanGraphData | StudioInvocationGraphData;
export type StudioGraphNode = Node<StudioGraphData>;

export interface StudioGraph {
  readonly nodes: StudioGraphNode[];
  readonly edges: Edge[];
}

const planColumnSpacing = 345;
const planRowSpacing = 256;

export function positionForNode(
  nodeId: string,
  automaticPosition: XYPosition,
  savedPositions: ReadonlyMap<string, XYPosition> | undefined,
): XYPosition {
  return savedPositions?.get(nodeId) ?? automaticPosition;
}

function sameStringValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sessionSource(
  session: StudioPlanNodeSnapshot["session"],
): string | undefined {
  return session?.type === "reuse" || session?.type === "branch"
    ? session.from
    : undefined;
}

function samePlanNode(
  left: StudioPlanNodeSnapshot,
  right: StudioPlanNodeSnapshot,
): boolean {
  return (
    left.planNodeId === right.planNodeId &&
    left.type === right.type &&
    left.label === right.label &&
    left.taskId === right.taskId &&
    left.session?.type === right.session?.type &&
    sessionSource(left.session) === sessionSource(right.session) &&
    left.parentPlanNodeId === right.parentPlanNodeId &&
    left.siblingOrder === right.siblingOrder &&
    left.maximumIterations === right.maximumIterations &&
    sameStringValues(left.dependsOn, right.dependsOn)
  );
}

function sameMetrics(
  left: StudioInvocationSnapshot["output"]["metrics"],
  right: StudioInvocationSnapshot["output"]["metrics"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRenderedInvocation(
  left: StudioInvocationSnapshot,
  right: StudioInvocationSnapshot,
): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.planNodeId === right.planNodeId &&
    left.taskId === right.taskId &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.parentInvocationId === right.parentInvocationId &&
    left.iteration === right.iteration &&
    left.siblingOrder === right.siblingOrder &&
    left.state === right.state &&
    left.input?.state === right.input?.state &&
    left.result?.state === right.result?.state &&
    left.startedAt === right.startedAt &&
    left.finishedAt === right.finishedAt &&
    sameMetrics(left.output.metrics, right.output.metrics) &&
    left.validation?.sourceId === right.validation?.sourceId &&
    left.validation?.verdict === right.validation?.verdict &&
    left.validation?.continued === right.validation?.continued &&
    left.validation?.evidence?.state === right.validation?.evidence?.state &&
    sameStringValues(left.dependencyIds, right.dependencyIds)
  );
}

function sameInvocationContext(
  left: InvocationDisplayContext | undefined,
  right: InvocationDisplayContext | undefined,
): boolean {
  return (
    left?.instanceIndex === right?.instanceIndex &&
    left?.instanceCount === right?.instanceCount &&
    left?.iteration === right?.iteration &&
    left?.iterationTotal === right?.iterationTotal &&
    sameStringValues(left?.scopePath ?? [], right?.scopePath ?? [])
  );
}

function sameGraphData(left: StudioGraphData, right: StudioGraphData): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "invocation" && right.kind === "invocation") {
    return (
      sameRenderedInvocation(left.invocation, right.invocation) &&
      sameInvocationContext(left.context, right.context)
    );
  }
  if (left.kind !== "plan" || right.kind !== "plan") return false;
  return (
    samePlanNode(left.planNode, right.planNode) &&
    left.selectedInvocationId === right.selectedInvocationId &&
    left.onSelectInvocation === right.onSelectInvocation &&
    left.invocations.length === right.invocations.length &&
    left.invocations.every((invocation, index) => {
      const other = right.invocations[index];
      return (
        other !== undefined &&
        sameRenderedInvocation(invocation, other) &&
        sameInvocationContext(
          left.invocationContexts.get(invocation.invocationId),
          right.invocationContexts.get(other.invocationId),
        )
      );
    })
  );
}

function sameGraphNode(left: StudioGraphNode, right: StudioGraphNode): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.className === right.className &&
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.selected === right.selected &&
    left.draggable === right.draggable &&
    left.connectable === right.connectable &&
    left.selectable === right.selectable &&
    left.ariaLabel === right.ariaLabel &&
    sameGraphData(left.data, right.data)
  );
}

function sameEdges(left: readonly Edge[], right: readonly Edge[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (edge, index) =>
        edge.id === right[index]?.id &&
        edge.source === right[index]?.source &&
        edge.target === right[index]?.target &&
        edge.selectable === right[index]?.selectable &&
        JSON.stringify(edge.style) === JSON.stringify(right[index]?.style),
    )
  );
}

/**
 * Activities, output payloads, and run bookkeeping remain available to their
 * own views without forcing React Flow to replace graph nodes.
 */
export function hasSameGraphRendering(
  previous: StudioRunSnapshot,
  next: StudioRunSnapshot,
): boolean {
  return (
    previous.plan === next.plan &&
    previous.invocations.length === next.invocations.length &&
    previous.invocations.every((invocation, index) => {
      const other = next.invocations[index];
      return (
        other !== undefined &&
        (invocation === other || sameRenderedInvocation(invocation, other))
      );
    })
  );
}

/** Reuses unchanged React Flow inputs so live inspector events do not remount nodes. */
export function reconcileGraph(
  previous: StudioGraph | undefined,
  next: StudioGraph,
): StudioGraph {
  if (previous === undefined) return next;
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nodes = next.nodes.map((node) => {
    const existing = previousNodes.get(node.id);
    return existing !== undefined && sameGraphNode(existing, node)
      ? existing
      : node;
  });
  const edges = sameEdges(previous.edges, next.edges)
    ? previous.edges
    : next.edges;
  const isUnchanged =
    nodes.length === previous.nodes.length &&
    nodes.every((node, index) => node === previous.nodes[index]) &&
    edges === previous.edges;
  return isUnchanged ? previous : { nodes, edges };
}

function staticDepth(
  node: StudioPlanNodeSnapshot,
  byId: ReadonlyMap<string, StudioPlanNodeSnapshot>,
  depths: Map<string, number>,
  visiting = new Set<string>(),
): number {
  const cached = depths.get(node.planNodeId);
  if (cached !== undefined) return cached;
  if (visiting.has(node.planNodeId)) return 0;
  visiting.add(node.planNodeId);
  const upstream = [
    node.parentPlanNodeId === undefined
      ? undefined
      : byId.get(node.parentPlanNodeId),
    ...node.dependsOn.map((dependencyId) => byId.get(dependencyId)),
  ].filter(
    (candidate): candidate is StudioPlanNodeSnapshot => candidate !== undefined,
  );
  const depth =
    upstream.length === 0
      ? 0
      : Math.max(
          ...upstream.map((candidate) =>
            staticDepth(candidate, byId, depths, visiting),
          ),
        ) + 1;
  visiting.delete(node.planNodeId);
  depths.set(node.planNodeId, depth);
  return depth;
}

function invocationDepth(
  invocation: StudioInvocationSnapshot,
  byId: ReadonlyMap<string, StudioInvocationSnapshot>,
  depths: Map<string, number>,
  visiting = new Set<string>(),
): number {
  const cached = depths.get(invocation.invocationId);
  if (cached !== undefined) return cached;
  if (visiting.has(invocation.invocationId)) return 0;
  visiting.add(invocation.invocationId);
  const upstream = [
    invocation.parentInvocationId === undefined
      ? undefined
      : byId.get(invocation.parentInvocationId),
    ...invocation.dependencyIds.map((dependencyId) => byId.get(dependencyId)),
  ].filter(
    (candidate): candidate is StudioInvocationSnapshot =>
      candidate !== undefined,
  );
  const depth =
    upstream.length === 0
      ? 0
      : Math.max(
          ...upstream.map((candidate) =>
            invocationDepth(candidate, byId, depths, visiting),
          ),
        ) + 1;
  visiting.delete(invocation.invocationId);
  depths.set(invocation.invocationId, depth);
  return depth;
}

function planNodeState(
  invocations: readonly StudioInvocationSnapshot[],
): StudioInvocationState | "planned" {
  if (invocations.length === 0) return "planned";
  const priority: StudioInvocationState[] = [
    "active",
    "retrying",
    "failed",
    "waiting",
    "queued",
    "succeeded",
    "skipped",
    "cancelled",
  ];
  return (
    priority.find((state) =>
      invocations.some((invocation) => invocation.state === state),
    ) ?? "planned"
  );
}

export function graphFor(
  snapshot: StudioRunSnapshot,
  selectedInvocationId: string | undefined,
  savedPositions: ReadonlyMap<string, XYPosition> | undefined,
  onSelectInvocation?: (invocationId: string) => void,
): StudioGraph {
  const planNodes = snapshot.plan?.nodes ?? [];
  const planById = new Map(
    planNodes.map((planNode) => [planNode.planNodeId, planNode]),
  );
  const invocationsByPlanNode = new Map<string, StudioInvocationSnapshot[]>();
  for (const invocation of snapshot.invocations) {
    const invocations = invocationsByPlanNode.get(invocation.planNodeId) ?? [];
    invocations.push(invocation);
    invocationsByPlanNode.set(invocation.planNodeId, invocations);
  }

  const rows = new Map<number, number>();
  const planDepths = new Map<string, number>();
  const automaticPositions = new Map<string, XYPosition>();
  const sortedPlanNodes = [...planNodes].sort(
    (left, right) =>
      left.siblingOrder - right.siblingOrder ||
      left.planNodeId.localeCompare(right.planNodeId),
  );
  const invocationContexts = invocationContextMap(snapshot);
  for (const planNode of sortedPlanNodes) {
    const depth = staticDepth(planNode, planById, planDepths);
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    automaticPositions.set(planNode.planNodeId, {
      x: depth * planColumnSpacing,
      y: row * planRowSpacing,
    });
  }

  const invocationById = new Map(
    snapshot.invocations.map((invocation) => [
      invocation.invocationId,
      invocation,
    ]),
  );
  const nodes: StudioGraphNode[] = sortedPlanNodes.map((planNode) => {
    const planId = `plan:${planNode.planNodeId}`;
    const invocations = [
      ...(invocationsByPlanNode.get(planNode.planNodeId) ?? []),
    ].sort(
      (left, right) =>
        (left.iteration ?? Number.MAX_SAFE_INTEGER) -
          (right.iteration ?? Number.MAX_SAFE_INTEGER) ||
        left.siblingOrder - right.siblingOrder ||
        left.invocationId.localeCompare(right.invocationId),
    );
    const state = planNodeState(invocations);
    const invocationLabel =
      invocations.length === 0
        ? "planned"
        : `${invocations.length} invocation${
            invocations.length === 1 ? "" : "s"
          }`;
    return {
      id: planId,
      position: positionForNode(
        planId,
        automaticPositions.get(planNode.planNodeId) ?? { x: 0, y: 0 },
        savedPositions,
      ),
      data: {
        kind: "plan",
        planNode,
        invocations,
        invocationContexts,
        onSelectInvocation,
        selectedInvocationId,
      },
      type: "studio-plan",
      className: [
        "studio-node",
        "studio-plan-node",
        `state-${state}`,
        invocations.length === 0 ? "" : "has-invocations",
      ]
        .filter(Boolean)
        .join(" "),
      selected: invocations.some(
        ({ invocationId }) => invocationId === selectedInvocationId,
      ),
      draggable: false,
      connectable: false,
      selectable: invocations.length > 0,
      ariaLabel: `${planNode.label}, ${invocationLabel}`,
    };
  });

  const runtimeRows = new Map<number, number>();
  const runtimeDepths = new Map<string, number>();
  const invocationsWithoutPlan = [...snapshot.invocations].filter(
    ({ planNodeId }) => !planById.has(planNodeId),
  );
  for (const invocation of invocationsWithoutPlan.sort(
    (left, right) =>
      left.siblingOrder - right.siblingOrder ||
      left.invocationId.localeCompare(right.invocationId),
  )) {
    const depth = invocationDepth(invocation, invocationById, runtimeDepths);
    const row = runtimeRows.get(depth) ?? 0;
    runtimeRows.set(depth, row + 1);
    const planPosition = automaticPositions.get(invocation.planNodeId);
    const automaticPosition =
      planPosition === undefined
        ? { x: depth * 440, y: row * 160 }
        : { x: planPosition.x + 32, y: planPosition.y + 150 + row * 160 };
    const invocationId = `invocation:${invocation.invocationId}`;
    nodes.push({
      id: invocationId,
      position: positionForNode(
        invocationId,
        automaticPosition,
        savedPositions,
      ),
      data: {
        kind: "invocation",
        invocation,
        context: invocationContexts.get(invocation.invocationId) ?? {
          instanceIndex: 1,
          instanceCount: 1,
          scopePath: [],
        },
      },
      type: "studio-invocation",
      className: `studio-node state-${invocation.state}`,
      selected: invocation.invocationId === selectedInvocationId,
      draggable: false,
      connectable: false,
      selectable: true,
      ariaLabel: `${invocation.label}, ${invocation.state}`,
    });
  }

  const edgePairs = new Set<string>();
  const staticEdges: Edge[] = [];
  for (const planNode of planNodes) {
    const relationships = [
      ...planNode.dependsOn.map((dependencyId) => ({
        dependencyId,
        kind: "static" as const,
      })),
      ...(planNode.parentPlanNodeId === undefined
        ? []
        : [
            {
              dependencyId: planNode.parentPlanNodeId,
              kind: "parent" as const,
            },
          ]),
    ];
    for (const { dependencyId, kind } of relationships) {
      if (!planById.has(dependencyId)) continue;
      const pair = `${dependencyId}->${planNode.planNodeId}`;
      if (edgePairs.has(pair)) continue;
      edgePairs.add(pair);
      staticEdges.push({
        id: `${kind}:${pair}`,
        source: `plan:${dependencyId}`,
        target: `plan:${planNode.planNodeId}`,
        selectable: false,
        ...(kind === "parent"
          ? {
              style: {
                stroke: "#bd8a20",
                strokeDasharray: "5 4",
              },
            }
          : {}),
      });
    }
  }
  const unknownInvocationIds = new Set(
    invocationsWithoutPlan.map(({ invocationId }) => invocationId),
  );
  const runtimeEdges = invocationsWithoutPlan.flatMap((invocation) =>
    invocation.dependencyIds
      .filter(
        (dependencyId) =>
          invocationById.has(dependencyId) &&
          unknownInvocationIds.has(dependencyId),
      )
      .map(
        (dependencyId) =>
          ({
            id: `runtime:${dependencyId}->${invocation.invocationId}`,
            source: `invocation:${dependencyId}`,
            target: `invocation:${invocation.invocationId}`,
            selectable: false,
          }) satisfies Edge,
      ),
  );
  return { nodes, edges: [...staticEdges, ...runtimeEdges] };
}
