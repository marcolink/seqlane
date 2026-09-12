import type { InvocationId, PlanNodeId } from "@seqlane/core";
import type { PreparedPlanExecution } from "../compile/compile-plan.js";

export interface SharedSessionInvocation {
  readonly nodeId: PlanNodeId;
  readonly invocationId: InvocationId;
}

export interface SharedSessionTaskPair {
  readonly first: SharedSessionInvocation;
  readonly second: SharedSessionInvocation;
  readonly ordered: boolean;
}

export class UnorderedSharedSessionError extends Error {
  readonly first: SharedSessionInvocation;
  readonly second: SharedSessionInvocation;

  constructor(pair: SharedSessionTaskPair) {
    super(
      `Tasks "${pair.first.nodeId}" and "${pair.second.nodeId}" share a session without a DAG dependency`,
    );
    this.name = "UnorderedSharedSessionError";
    this.first = pair.first;
    this.second = pair.second;
  }
}

/** Reports resolved same-session task pairs and their DAG ordering. */
export function preflightSharedSessionOrder(
  compiled: PreparedPlanExecution,
): readonly SharedSessionTaskPair[] {
  const nodesById = new Map(
    compiled.orderedNodes.map((node) => [node.nodeId, node]),
  );
  const sessions = new Map<symbol, SharedSessionInvocation[]>();

  for (const node of compiled.orderedNodes) {
    const invocationId = compiled.context.invocationIds.get(node.nodeId);
    if (invocationId === undefined) continue;
    const session = compiled.context.resolvedSessions.get(invocationId);
    if (session === undefined) continue;

    const invocations = sessions.get(session.key) ?? [];
    invocations.push({ nodeId: node.nodeId, invocationId });
    sessions.set(session.key, invocations);
  }

  const pairs: SharedSessionTaskPair[] = [];
  for (const invocations of sessions.values()) {
    for (let firstIndex = 0; firstIndex < invocations.length; firstIndex += 1) {
      const first = invocations[firstIndex];
      if (first === undefined) continue;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < invocations.length;
        secondIndex += 1
      ) {
        const second = invocations[secondIndex];
        if (second === undefined) continue;
        pairs.push({
          first,
          second,
          ordered:
            hasDependencyPath(nodesById, first.nodeId, second.nodeId) ||
            hasDependencyPath(nodesById, second.nodeId, first.nodeId),
        });
      }
    }
  }
  return pairs;
}

export function rejectUnorderedSharedSessionPairs(
  pairs: readonly SharedSessionTaskPair[],
): void {
  const unordered = pairs.find((pair) => !pair.ordered);
  if (unordered !== undefined) throw new UnorderedSharedSessionError(unordered);
}

function hasDependencyPath(
  nodesById: ReadonlyMap<
    PlanNodeId,
    { readonly dependsOn: readonly PlanNodeId[] }
  >,
  nodeId: PlanNodeId,
  dependencyId: PlanNodeId,
): boolean {
  const pending = [nodeId];
  const visited = new Set<PlanNodeId>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const node = nodesById.get(current);
    if (node === undefined) continue;
    for (const predecessor of node.dependsOn) {
      if (predecessor === dependencyId) return true;
      pending.push(predecessor);
    }
  }
  return false;
}
