import type { StudioGraph } from "./graph-layout.js";

const estimatedPlanCardHeight = 256;
const planCardGap = 20;

export interface GraphNodeMeasurement {
  readonly width: number;
  readonly height: number;
}

interface DimensionChange {
  readonly id?: string;
  readonly type: string;
  readonly dimensions?: {
    readonly width?: number;
    readonly height?: number;
  };
}

export function measurementsFromNodeChanges(
  changes: readonly DimensionChange[],
): readonly (readonly [string, GraphNodeMeasurement])[] {
  return changes.flatMap((change) => {
    const width = change.dimensions?.width;
    const height = change.dimensions?.height;
    if (
      change.type !== "dimensions" ||
      change.id === undefined ||
      width === undefined ||
      height === undefined ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return [];
    }
    return [[change.id, { width, height }]];
  });
}

/** Applies React Flow's measured dimensions to freshly projected graph nodes. */
export function applyGraphMeasurements(
  graph: StudioGraph,
  measurements: ReadonlyMap<string, GraphNodeMeasurement> | undefined,
): StudioGraph {
  if (measurements === undefined || measurements.size === 0) return graph;
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const measurement = measurements.get(node.id);
    if (
      measurement === undefined ||
      (node.measured?.width === measurement.width &&
        node.measured.height === measurement.height)
    ) {
      return node;
    }
    changed = true;
    return { ...node, measured: measurement };
  });

  const planNodesByColumn = new Map<number, typeof nodes>();
  for (const node of nodes) {
    if (node.data.kind !== "plan") continue;
    const column = planNodesByColumn.get(node.position.x) ?? [];
    column.push(node);
    planNodesByColumn.set(node.position.x, column);
  }

  const positions = new Map<string, number>();
  for (const planNodes of planNodesByColumn.values()) {
    const sorted = [...planNodes].sort(
      (left, right) => left.position.y - right.position.y,
    );
    let nextY = sorted[0]?.position.y ?? 0;
    for (const node of sorted) {
      positions.set(node.id, nextY);
      nextY += (node.measured?.height ?? estimatedPlanCardHeight) + planCardGap;
    }
  }

  const reflowedNodes = nodes.map((node) => {
    const y = positions.get(node.id);
    if (y === undefined || node.position.y === y) return node;
    changed = true;
    return { ...node, position: { ...node.position, y } };
  });
  return changed ? { ...graph, nodes: reflowedNodes } : graph;
}
