import type {
  StudioInvocationSnapshot,
  StudioPlanNodeSnapshot,
  StudioRunSnapshot,
} from "@seqlane/studio/protocol";

export interface InvocationDisplayContext {
  readonly instanceIndex: number;
  readonly instanceCount: number;
  readonly iteration?: number;
  readonly iterationTotal?: number;
  readonly scopePath: readonly string[];
}

function groupKey(invocation: StudioInvocationSnapshot): string {
  return `${invocation.parentInvocationId ?? "root"}:${invocation.planNodeId}`;
}

function repeatMaximum(
  invocation: StudioInvocationSnapshot,
  planById: ReadonlyMap<string, StudioPlanNodeSnapshot>,
): number | undefined {
  let planNode = planById.get(invocation.planNodeId);
  const seen = new Set<string>();
  while (planNode !== undefined && !seen.has(planNode.planNodeId)) {
    seen.add(planNode.planNodeId);
    if (
      planNode.type === "repeat" &&
      planNode.maximumIterations !== undefined
    ) {
      return planNode.maximumIterations;
    }
    planNode =
      planNode.parentPlanNodeId === undefined
        ? undefined
        : planById.get(planNode.parentPlanNodeId);
  }
  return undefined;
}

function scopePath(
  invocation: StudioInvocationSnapshot,
  invocationById: ReadonlyMap<string, StudioInvocationSnapshot>,
): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let parentId = invocation.parentInvocationId;
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = invocationById.get(parentId);
    if (parent === undefined) break;
    path.unshift(parent.label);
    parentId = parent.parentInvocationId;
  }
  return path;
}

export function invocationContextMap(
  snapshot: StudioRunSnapshot,
): ReadonlyMap<string, InvocationDisplayContext> {
  const invocationById = new Map(
    snapshot.invocations.map((invocation) => [
      invocation.invocationId,
      invocation,
    ]),
  );
  const planById = new Map(
    (snapshot.plan?.nodes ?? []).map((planNode) => [
      planNode.planNodeId,
      planNode,
    ]),
  );
  const groups = new Map<string, StudioInvocationSnapshot[]>();
  for (const invocation of snapshot.invocations) {
    const group = groups.get(groupKey(invocation)) ?? [];
    group.push(invocation);
    groups.set(groupKey(invocation), group);
  }

  const contexts = new Map<string, InvocationDisplayContext>();
  for (const invocation of snapshot.invocations) {
    const group = [...(groups.get(groupKey(invocation)) ?? [])].sort(
      (left, right) =>
        (left.iteration ?? Number.MAX_SAFE_INTEGER) -
          (right.iteration ?? Number.MAX_SAFE_INTEGER) ||
        left.siblingOrder - right.siblingOrder ||
        left.invocationId.localeCompare(right.invocationId),
    );
    const instanceIndex = Math.max(
      0,
      group.findIndex(
        ({ invocationId }) => invocationId === invocation.invocationId,
      ),
    );
    contexts.set(invocation.invocationId, {
      instanceIndex: instanceIndex + 1,
      instanceCount: group.length,
      ...(invocation.iteration === undefined
        ? {}
        : {
            iteration: invocation.iteration,
            iterationTotal: repeatMaximum(invocation, planById),
          }),
      scopePath: scopePath(invocation, invocationById),
    });
  }
  return contexts;
}

export function formatInvocationContext(
  context: InvocationDisplayContext | undefined,
): string | undefined {
  if (context === undefined) return undefined;
  const instance =
    context.iteration === undefined
      ? context.instanceCount > 1
        ? `Instance ${context.instanceIndex}/${context.instanceCount}`
        : undefined
      : `Iteration ${context.iteration}${
          context.iterationTotal === undefined
            ? ""
            : `/${context.iterationTotal}`
        }`;
  const scope =
    context.scopePath.length === 0
      ? undefined
      : `in ${context.scopePath.join(" › ")}`;
  return (
    [instance, scope]
      .filter((value): value is string => value !== undefined)
      .join(" · ") || undefined
  );
}
