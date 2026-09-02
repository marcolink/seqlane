import {
  valueRefSchema,
  type ValueBinding,
  type ValueRef,
} from "@seqlane/core";

export const WORKFLOW_INPUT_NODE_ID = "__seqlane_input";

export class BindingResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingResolutionError";
  }
}

function collectReferenceNodeIds(
  binding: ValueBinding,
  nodeIds: Set<string>,
): void {
  const reference = valueRefSchema.safeParse(binding);
  if (reference.success) {
    nodeIds.add(reference.data.nodeId);
    return;
  }

  if (Array.isArray(binding)) {
    for (const item of binding) collectReferenceNodeIds(item, nodeIds);
    return;
  }

  if (typeof binding === "object" && binding !== null) {
    for (const value of Object.values(binding)) {
      collectReferenceNodeIds(value, nodeIds);
    }
  }
}

export function referencedNodeIds(binding: ValueBinding): ReadonlySet<string> {
  const nodeIds = new Set<string>();
  collectReferenceNodeIds(binding, nodeIds);
  return nodeIds;
}

function resolveReference(
  reference: ValueRef,
  workflowInput: unknown,
  results: ReadonlyMap<string, unknown>,
): unknown {
  if (reference.nodeId === WORKFLOW_INPUT_NODE_ID) {
    return traversePath(workflowInput, reference.path, reference.nodeId);
  }

  if (!results.has(reference.nodeId)) {
    throw new BindingResolutionError(
      `No result is available for Plan node "${reference.nodeId}"`,
    );
  }

  const result = results.get(reference.nodeId);
  if (
    reference.path[0] === "output" &&
    (typeof result !== "object" ||
      result === null ||
      !Object.prototype.hasOwnProperty.call(result, "output"))
  ) {
    // Typed authoring addresses the invocation envelope as output.*. Older
    // hand-authored Plans address the raw task result directly.
    return traversePath(result, reference.path.slice(1), reference.nodeId);
  }

  return traversePath(result, reference.path, reference.nodeId);
}

function traversePath(
  value: unknown,
  path: readonly string[],
  nodeId: string,
): unknown {
  let current = value;

  for (const segment of path) {
    if (
      current === null ||
      current === undefined ||
      !Object.prototype.hasOwnProperty.call(Object(current), segment)
    ) {
      throw new BindingResolutionError(
        `Path "${path.join(".")}" is missing on Plan node "${nodeId}"`,
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function resolveBinding(
  binding: ValueBinding,
  workflowInput: unknown,
  results: ReadonlyMap<string, unknown>,
): unknown {
  const reference = valueRefSchema.safeParse(binding);
  if (reference.success) {
    return resolveReference(reference.data, workflowInput, results);
  }

  if (Array.isArray(binding)) {
    return binding.map((item) => resolveBinding(item, workflowInput, results));
  }

  if (typeof binding === "object" && binding !== null) {
    return Object.fromEntries(
      Object.entries(binding).map(([key, value]) => [
        key,
        resolveBinding(value, workflowInput, results),
      ]),
    );
  }

  return binding;
}
