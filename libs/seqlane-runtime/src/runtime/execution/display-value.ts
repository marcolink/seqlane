import type {
  JsonValue,
  SeqlaneDisplayValue,
  SeqlaneOutputSummary,
  SeqlaneStudioValueSelection,
} from "@seqlane/core";
import { isJsonValue } from "@seqlane/core";
import { summarizeSeqlaneOutput } from "./output-summary.js";

const MAX_JSON_BYTES = 32 * 1024;
const MAX_DEPTH = 16;
const MAX_DIRECT_ENTRIES = 100;

interface SelectionNode {
  whole: boolean;
  readonly children: Map<string, SelectionNode>;
}

const missing = Symbol("missing");

function selectionNode(whole = false): SelectionNode {
  return { whole, children: new Map() };
}

function parsePointer(pointer: string): readonly string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) {
    return undefined;
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function buildSelection(
  selection: SeqlaneStudioValueSelection | undefined,
): SelectionNode | undefined {
  if (selection === undefined) return selectionNode(true);
  if (selection.includePaths.length === 0) {
    return undefined;
  }

  const root = selectionNode();
  for (const pointer of selection.includePaths) {
    const segments = parsePointer(pointer);
    if (segments === undefined) continue;
    let current = root;
    for (const segment of segments) {
      const child = current.children.get(segment) ?? selectionNode();
      current.children.set(segment, child);
      current = child;
    }
    current.whole = true;
  }
  return root.whole || root.children.size > 0 ? root : undefined;
}

function arrayIndex(segment: string, length: number): number | undefined {
  if (!/^0$|^[1-9]\d*$/.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) && index < length ? index : undefined;
}

function projectValue(value: unknown, selection: SelectionNode): unknown {
  if (selection.whole) return value;
  if (Array.isArray(value)) {
    const selected = [...selection.children.entries()]
      .map(
        ([segment, child]) =>
          [arrayIndex(segment, value.length), child] as const,
      )
      .filter(
        (entry): entry is readonly [number, SelectionNode] =>
          entry[0] !== undefined,
      );
    if (selected.length === 0) return missing;
    const result = Array.from(
      { length: Math.max(...selected.map(([index]) => index)) + 1 },
      () => null as JsonValue,
    );
    for (const [index, child] of selected) {
      const projected = projectValue(value[index], child);
      if (projected !== missing) result[index] = projected as JsonValue;
    }
    return result;
  }
  if (typeof value !== "object" || value === null) return missing;

  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of selection.children) {
    if (!Object.hasOwn(value, key)) continue;
    const projected = projectValue(
      (value as { readonly [key: string]: unknown })[key],
      child,
    );
    if (projected !== missing) result[key] = projected as JsonValue;
  }
  return Object.keys(result).length === 0 ? missing : result;
}

function exceedsLimits(value: JsonValue): boolean {
  let tooDeep = false;
  let tooManyEntries = false;

  const visit = (current: JsonValue, depth: number): void => {
    if (tooDeep || tooManyEntries) return;
    if (Array.isArray(current)) {
      if (current.length > MAX_DIRECT_ENTRIES) {
        tooManyEntries = true;
        return;
      }
      if (depth > MAX_DEPTH) {
        tooDeep = true;
        return;
      }
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    const keys = Object.keys(current);
    if (keys.length > MAX_DIRECT_ENTRIES) {
      tooManyEntries = true;
      return;
    }
    if (depth > MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    for (const key of keys) {
      const child = (current as { readonly [key: string]: JsonValue })[key];
      if (child !== undefined) visit(child, depth + 1);
    }
  };

  visit(value, 1);
  return tooDeep || tooManyEntries;
}

function summary(value: JsonValue): SeqlaneOutputSummary {
  return summarizeSeqlaneOutput(value);
}

export function toSeqlaneDisplayValue(
  value: unknown,
  selection: SeqlaneStudioValueSelection | undefined,
): SeqlaneDisplayValue {
  const selectionTree = buildSelection(selection);
  if (selectionTree === undefined) {
    return { state: "omitted", reason: "policy" };
  }

  const projected = projectValue(value, selectionTree);
  if (projected === missing || !isJsonValue(projected)) {
    return { state: "omitted", reason: "unavailable" };
  }

  const projectedSummary = summary(projected);
  if (exceedsLimits(projected)) {
    return { state: "truncated", summary: projectedSummary };
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(projected);
  } catch {
    return { state: "omitted", reason: "unavailable" };
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) {
    return { state: "truncated", summary: projectedSummary };
  }
  return { state: "present", value: projected };
}
