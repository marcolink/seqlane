import type { RunAggregate, RunNode, RunViewModel } from "./run-view-model.js";

export const EMPTY_AGGREGATE: RunAggregate = {
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

export function compareNodes(left: RunNode, right: RunNode): number {
  return (
    left.siblingOrder - right.siblingOrder ||
    left.createdSequence - right.createdSequence ||
    left.invocationId.localeCompare(right.invocationId)
  );
}

export function aggregateForNode(node: Pick<RunNode, "state">): RunAggregate {
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

export function aggregateDelta(
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

export function addAggregate(
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

export function isEmptyAggregate(aggregate: RunAggregate): boolean {
  return Object.values(aggregate).every((value) => value === 0);
}

export function rebuildTopology(
  view: RunViewModel,
  sourceNodes: ReadonlyMap<string, RunNode>,
): RunViewModel {
  const childrenByParent = new Map<string, string[]>();
  const dependentsByDependency = new Map<string, string[]>();
  for (const node of sourceNodes.values()) {
    for (const dependencyId of node.dependencyIds) {
      const dependents = dependentsByDependency.get(dependencyId) ?? [];
      dependents.push(node.invocationId);
      dependentsByDependency.set(dependencyId, dependents);
    }
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
        node.kind === "workflow" ||
        node.kind === "loop" ||
        node.kind === "choice"
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
  rebuildAggregates(nodes, childrenByParent);
  return {
    ...view,
    nodes,
    childrenByParent,
    dependentsByDependency,
    rootInvocationIds,
  };
}

/** Mutates only the newly built topology map. */
function rebuildAggregates(
  nodes: Map<string, RunNode>,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
): void {
  const remaining = new Map(
    [...nodes.keys()].map((id) => [id, childrenByParent.get(id)?.length ?? 0]),
  );
  const totals = new Map(
    [...nodes.values()].map((node) => [
      node.invocationId,
      aggregateForNode(node),
    ]),
  );
  const pending = [...nodes.keys()].filter((id) => remaining.get(id) === 0);
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (id === undefined) continue;
    const node = nodes.get(id);
    if (node === undefined) continue;
    const total = totals.get(id) ?? EMPTY_AGGREGATE;
    if (
      node.kind === "workflow" ||
      node.kind === "loop" ||
      node.kind === "choice"
    ) {
      nodes.set(id, {
        ...node,
        aggregate: aggregateDelta(total, aggregateForNode(node)),
      });
    }
    const parent = node.parentInvocationId;
    if (parent === undefined || !nodes.has(parent)) continue;
    totals.set(
      parent,
      addAggregate(totals.get(parent) ?? EMPTY_AGGREGATE, total),
    );
    const count = (remaining.get(parent) ?? 1) - 1;
    remaining.set(parent, count);
    if (count === 0) pending.push(parent);
  }
}

export function addChildToTopology(
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

export function rootInvocationIds(
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
