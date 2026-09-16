import { rebuildTopology } from "./run-topology.js";
import type { OutputEvent, RunNode, RunViewModel } from "./run-view-model.js";

type PlanNode = Extract<
  OutputEvent,
  { type: "run.plan" }
>["plan"]["nodes"][number];
type CreatedEvent = Extract<OutputEvent, { type: "invocation.created" }>;
type StartedEvent = Extract<OutputEvent, { type: "invocation.started" }>;
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
  if (node.type === "validation.gate") {
    return { type: "validation-gate", planNodeId: node.planNodeId };
  }
  if (node.type === "validation.check" && node.taskId === undefined) {
    return { type: "validator", validatorId: node.label };
  }
  return { type: "task", taskId: node.taskId ?? node.label };
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

export function indexPlanPlaceholders(
  nodes: ReadonlyMap<string, RunNode>,
): Pick<
  RunViewModel,
  "plannedInvocationByNodeId" | "plannedInvocationsByTaskId"
> {
  const plannedInvocationByNodeId = new Map<string, string>();
  const plannedInvocationsByTaskId = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (!node.invocationId.startsWith("plan:")) continue;
    plannedInvocationByNodeId.set(node.planNodeId, node.invocationId);
    const taskIds = plannedInvocationsByTaskId.get(node.taskId) ?? [];
    taskIds.push(node.invocationId);
    plannedInvocationsByTaskId.set(node.taskId, taskIds);
  }
  return { plannedInvocationByNodeId, plannedInvocationsByTaskId };
}

export function plannedInvocationForCreated(
  view: RunViewModel,
  event: CreatedEvent,
): string | undefined {
  const exact = view.plannedInvocationByNodeId.get(event.planNodeId);
  if (exact !== undefined) return exact;
  if (event.taskId === undefined) return undefined;
  const candidates = view.plannedInvocationsByTaskId.get(event.taskId) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function plannedInvocationForSubject(
  view: RunViewModel,
  subject: StartedSubject,
): string | undefined {
  if (subject.type === "validation-gate") {
    return view.plannedInvocationByNodeId.get(subject.planNodeId);
  }
  const identity =
    subject.type === "task" ? subject.taskId : subject.validatorId;
  const candidates = view.plannedInvocationsByTaskId.get(identity) ?? [];
  if (candidates.length === 1) return candidates[0];
  const validationCandidates = [...view.plannedInvocationByNodeId.values()]
    .map((id) => view.nodes.get(id))
    .filter(
      (node): node is RunNode =>
        node !== undefined &&
        node.kind === "validation" &&
        (subject.type === "task" || node.label === subject.validatorId),
    );
  return validationCandidates.length === 1
    ? validationCandidates[0]?.invocationId
    : undefined;
}

/** Rename one placeholder by updating only its indexed reverse references. */
export function reconcilePlanPlaceholder(
  view: RunViewModel,
  oldId: string,
  invocationId: string,
): RunViewModel {
  const placeholder = view.nodes.get(oldId);
  if (placeholder === undefined || oldId === invocationId) return view;
  const nodes = new Map(view.nodes);
  nodes.delete(oldId);
  nodes.set(invocationId, { ...placeholder, invocationId });

  const childrenByParent = new Map(view.childrenByParent);
  const children = childrenByParent.get(oldId);
  if (children !== undefined) {
    childrenByParent.delete(oldId);
    childrenByParent.set(invocationId, children);
    for (const childId of children) {
      const child = nodes.get(childId);
      if (child !== undefined) {
        nodes.set(childId, { ...child, parentInvocationId: invocationId });
      }
    }
  }
  if (placeholder.parentInvocationId !== undefined) {
    const siblings = childrenByParent.get(placeholder.parentInvocationId);
    if (siblings !== undefined) {
      childrenByParent.set(
        placeholder.parentInvocationId,
        siblings.map((id) => (id === oldId ? invocationId : id)),
      );
    }
  }

  const dependentsByDependency = new Map(view.dependentsByDependency);
  const dependents = dependentsByDependency.get(oldId);
  if (dependents !== undefined) {
    dependentsByDependency.delete(oldId);
    dependentsByDependency.set(invocationId, dependents);
    for (const dependentId of dependents) {
      const dependent = nodes.get(dependentId);
      if (dependent !== undefined) {
        nodes.set(dependentId, {
          ...dependent,
          dependencyIds: dependent.dependencyIds.map((id) =>
            id === oldId ? invocationId : id,
          ),
        });
      }
    }
  }
  for (const dependencyId of placeholder.dependencyIds) {
    const reverse = dependentsByDependency.get(dependencyId);
    if (reverse !== undefined) {
      dependentsByDependency.set(
        dependencyId,
        reverse.map((id) => (id === oldId ? invocationId : id)),
      );
    }
  }

  const presentation = new Map(view.presentation);
  const presentationState = presentation.get(oldId);
  presentation.delete(oldId);
  if (presentationState !== undefined) {
    presentation.set(invocationId, presentationState);
  }
  const plannedInvocationByNodeId = new Map(view.plannedInvocationByNodeId);
  plannedInvocationByNodeId.delete(placeholder.planNodeId);
  const plannedInvocationsByTaskId = new Map(view.plannedInvocationsByTaskId);
  const taskCandidates = plannedInvocationsByTaskId.get(placeholder.taskId);
  if (taskCandidates !== undefined) {
    const remaining = taskCandidates.filter((id) => id !== oldId);
    if (remaining.length === 0) {
      plannedInvocationsByTaskId.delete(placeholder.taskId);
    } else {
      plannedInvocationsByTaskId.set(placeholder.taskId, remaining);
    }
  }
  return {
    ...view,
    nodes,
    childrenByParent,
    dependentsByDependency,
    presentation,
    rootInvocationIds: view.rootInvocationIds.map((id) =>
      id === oldId ? invocationId : id,
    ),
    plannedInvocationByNodeId,
    plannedInvocationsByTaskId,
  };
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
  const projected = rebuildTopology({ ...view, presentation }, nodes);
  return {
    view: { ...projected, ...indexPlanPlaceholders(projected.nodes) },
    consumed,
  };
}

/** Rename a burst of planned placeholders before applying lifecycle updates. */
export function reconcileStartedBatch(
  view: RunViewModel,
  events: readonly StartedEvent[],
): RunViewModel {
  if (events.length < 2) return view;
  const replacements = new Map<string, string>();
  const replacementIds = new Set<string>();
  for (const event of events) {
    if (view.nodes.has(event.invocationId)) continue;
    const placeholderId = plannedInvocationForSubject(view, event.subject);
    if (
      placeholderId === undefined ||
      replacements.has(placeholderId) ||
      replacementIds.has(event.invocationId)
    ) {
      continue;
    }
    replacements.set(placeholderId, event.invocationId);
    replacementIds.add(event.invocationId);
  }
  if (replacements.size === 0) return view;
  const replace = (id: string): string => replacements.get(id) ?? id;
  const nodes = new Map<string, RunNode>();
  for (const [oldId, node] of view.nodes) {
    nodes.set(replace(oldId), {
      ...node,
      invocationId: replace(oldId),
      ...(node.parentInvocationId === undefined
        ? {}
        : { parentInvocationId: replace(node.parentInvocationId) }),
      dependencyIds: node.dependencyIds.map(replace),
    });
  }
  const presentation = new Map<string, { readonly isExpanded: boolean }>();
  for (const [id, state] of view.presentation) {
    presentation.set(replace(id), state);
  }
  const projected = rebuildTopology({ ...view, presentation }, nodes);
  return { ...projected, ...indexPlanPlaceholders(projected.nodes) };
}
