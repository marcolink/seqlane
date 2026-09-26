import type { RunNode, RunViewModel } from "./run-view-model.js";
import { withMapChanges } from "./run-node-map.js";

export type RetainedValueKind =
  "input" | "result" | "activity" | "observation" | "validation";

export interface RetainedValueEntry {
  readonly invocationId: string;
  readonly kind: RetainedValueKind;
  readonly id?: string;
  readonly bytes: number;
}

function entryKey(entry: Omit<RetainedValueEntry, "bytes">): string {
  return JSON.stringify([entry.invocationId, entry.kind, entry.id]);
}

function withoutValue(node: RunNode, entry: RetainedValueEntry): RunNode {
  switch (entry.kind) {
    case "input":
      return { ...node, input: undefined };
    case "result":
      return {
        ...node,
        result: undefined,
        validation:
          node.validation === undefined
            ? undefined
            : { ...node.validation, evidence: undefined },
      };
    case "activity": {
      const activityDetails = new Map(node.activityDetails);
      activityDetails.delete(entry.id ?? "");
      return { ...node, activityDetails };
    }
    case "observation": {
      const observations = new Map(node.observations);
      observations.delete(entry.id ?? "");
      return { ...node, observations };
    }
    case "validation":
      return {
        ...node,
        validation:
          node.validation === undefined
            ? undefined
            : { ...node.validation, evidence: undefined },
      };
  }
}

/** Keep complete recent values; evict whole records instead of shortening JSON. */
export function retainRunValue(
  view: RunViewModel,
  identity: Omit<RetainedValueEntry, "bytes">,
  value: unknown,
): RunViewModel {
  if (!view.nodes.has(identity.invocationId) || value === undefined)
    return view;
  const key = entryKey(identity);
  const entries = new Map(view.retainedValueEntries);
  const previous = entries.get(key);
  entries.delete(key);
  let bytes = view.retainedValueBytes - (previous?.bytes ?? 0);
  let evicted = view.evictedValueCount;
  const changes = new Map<string, RunNode>();
  const evictEntry = (entry: RetainedValueEntry): void => {
    const node =
      changes.get(entry.invocationId) ?? view.nodes.get(entry.invocationId);
    if (node === undefined) return;
    changes.set(entry.invocationId, withoutValue(node, entry));
  };
  const size = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size <= view.limits.runValueBytes && view.limits.runValueEntries > 0) {
    entries.set(key, { ...identity, bytes: size });
    bytes += size;
  } else {
    evictEntry({ ...identity, bytes: size });
    evicted += 1;
  }
  while (
    bytes > view.limits.runValueBytes ||
    entries.size > view.limits.runValueEntries
  ) {
    const oldest = entries.entries().next().value;
    if (oldest === undefined) break;
    const [oldestKey, entry] = oldest;
    entries.delete(oldestKey);
    bytes -= entry.bytes;
    evicted += 1;
    evictEntry(entry);
  }
  return {
    ...view,
    nodes: withMapChanges(view.nodes, changes),
    retainedValueEntries: entries,
    retainedValueBytes: bytes,
    evictedValueCount: evicted,
  };
}
