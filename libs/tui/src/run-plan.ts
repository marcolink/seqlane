import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { rebuildTopology } from "./run-topology.js";
import type { OutputEvent, RunNode, RunViewModel } from "./run-view-model.js";

type PlanNode = Extract<
  OutputEvent,
  { type: "run.plan" }
>["plan"]["nodes"][number];
type CreatedEvent = Extract<OutputEvent, { type: "invocation.created" }>;
type StartedSubject = Extract<
  OutputEvent,
  { type: "invocation.started" }
>["subject"];

export function planNodeKind(node: PlanNode): RunNode["kind"] {
  if (node.type === "workflow") return "workflow";
  if (node.type === "repeat") return "loop";
  if (node.type.startsWith("validation.")) return "validation";
  return "task";
}

function planNodeSubject(node: PlanNode): CreatedEvent["subject"] {
  if (node.type === "task" && node.taskId !== undefined) {
    return { type: "task", taskId: node.taskId };
  }
  return { type: "validation-gate", planNodeId: node.planNodeId };
}

export function plannedInvocation(
  event: Extract<OutputEvent, { type: "run.plan" }>,
  node: PlanNode,
  identities: ReadonlyMap<string, string>,
): CreatedEvent {
  return {
    type: "invocation.created",
    metadata: event.metadata,
    workId: event.workId,
    runId: event.runId,
    invocationId: `plan:${node.planNodeId}`,
    planNodeId: node.planNodeId,
    subject: planNodeSubject(node),
    taskId: node.taskId,
    kind: planNodeKind(node),
    label: node.label,
    parentInvocationId:
      node.parentPlanNodeId === undefined
        ? undefined
        : (identities.get(node.parentPlanNodeId) ??
          `plan:${node.parentPlanNodeId}`),
    siblingOrder: node.siblingOrder,
    dependencyIds: node.dependsOn.map(
      (id) => identities.get(id) ?? `plan:${id}`,
    ),
  };
}

function uniquePlanPlaceholder(
  placeholders: readonly RunNode[],
  matches: (node: RunNode) => boolean,
): RunNode | undefined {
  const candidates = placeholders.filter(matches);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function planPlaceholderForSubject(
  placeholders: readonly RunNode[],
  subject: StartedSubject,
): RunNode | undefined {
  switch (subject.type) {
    case "validation-gate":
      return placeholders.find(
        (node) => node.planNodeId === subject.planNodeId,
      );
    case "task":
      return (
        uniquePlanPlaceholder(
          placeholders,
          (node) => node.taskId === subject.taskId,
        ) ??
        uniquePlanPlaceholder(
          placeholders,
          (node) => node.kind === "validation",
        )
      );
    case "validator":
      return (
        uniquePlanPlaceholder(
          placeholders,
          (node) => node.taskId === subject.validatorId,
        ) ??
        uniquePlanPlaceholder(
          placeholders,
          (node) =>
            node.kind === "validation" && node.label === subject.validatorId,
        )
      );
  }
}

/** Reconcile a creation burst with one node scan and one topology rebuild. */
export function reconcileCreatedBatch(
  view: RunViewModel,
  events: readonly CreatedEvent[],
): { readonly view: RunViewModel; readonly consumed: ReadonlySet<string> } {
  if (events.length < 2) return { view, consumed: new Set() };
  const placeholders = [...view.nodes.values()].filter((node) =>
    node.invocationId.startsWith("plan:"),
  );
  const byPlanNodeId = new Map(
    placeholders.map((node) => [node.planNodeId, node] as const),
  );
  const byTaskId = new Map<string, RunNode | null>();
  for (const node of placeholders) {
    const current = byTaskId.get(node.taskId);
    byTaskId.set(node.taskId, current === undefined ? node : null);
  }

  const replacements = new Map<string, string>();
  const eventByOldId = new Map<string, CreatedEvent>();
  const consumed = new Set<string>();
  for (const event of events) {
    const placeholder =
      byPlanNodeId.get(event.planNodeId) ??
      (event.taskId === undefined ? undefined : byTaskId.get(event.taskId));
    if (
      placeholder === undefined ||
      placeholder === null ||
      view.nodes.has(event.invocationId) ||
      replacements.has(placeholder.invocationId)
    ) {
      continue;
    }
    replacements.set(placeholder.invocationId, event.invocationId);
    eventByOldId.set(placeholder.invocationId, event);
    consumed.add(event.invocationId);
  }
  if (replacements.size === 0) return { view, consumed };
  const replace = (id: string): string => replacements.get(id) ?? id;
  const nodes = new Map<string, RunNode>();
  for (const [oldId, node] of view.nodes) {
    const event = eventByOldId.get(oldId);
    const invocationId = replace(oldId);
    const parentInvocationId =
      event === undefined ? node.parentInvocationId : event.parentInvocationId;
    const dependencyIds =
      event === undefined ? node.dependencyIds : event.dependencyIds;
    nodes.set(invocationId, {
      ...node,
      invocationId,
      ...(event === undefined
        ? {}
        : {
            label: event.label,
            kind: event.kind,
            siblingOrder: event.siblingOrder,
            ...(event.iteration === undefined
              ? { iteration: undefined }
              : { iteration: event.iteration }),
          }),
      ...(parentInvocationId === undefined
        ? { parentInvocationId: undefined }
        : { parentInvocationId: replace(parentInvocationId) }),
      dependencyIds: dependencyIds.map(replace),
    });
  }
  const presentation = new Map<string, { readonly isExpanded: boolean }>();
  for (const [id, state] of view.presentation) {
    presentation.set(replace(id), state);
  }
  return {
    view: rebuildTopology({ ...view, presentation }, nodes),
    consumed,
  };
}

export function maxEventSequence(
  events: readonly SeqlaneExecutionEvent[],
  fallback: number,
): number {
  return events.reduce(
    (maximum, event) =>
      Math.max(maximum, event.metadata?.sequence ?? maximum + 1),
    fallback,
  );
}
