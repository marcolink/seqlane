import {
  conflictHandlersConfigSchema,
  type ConflictHandlersConfig,
  type ConflictPath,
  type ConflictHandlerRule,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";

const conflictHandlersError = (message: string, cause?: unknown) =>
  new ActionResolutionError(
    "input-validation",
    "CONFLICT_HANDLERS_INVALID",
    message,
    cause,
  );

export function parseConflictHandlers(value: unknown): ConflictHandlersConfig {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch (error: unknown) {
      throw conflictHandlersError(
        "The conflict-handlers input must be valid JSON.",
        error,
      );
    }
  }
  const parsed = conflictHandlersConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw conflictHandlersError(
      "The conflict-handlers input is invalid.",
      parsed.error,
    );
  }
  assertConflictHandlerPolicy(parsed.data);
  return parsed.data;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

interface GlobToken {
  readonly expression: string;
  readonly nextIndex: number;
}

function readStarToken(pattern: string, index: number): GlobToken {
  if (pattern[index + 1] !== "*") {
    return { expression: "[^/]*", nextIndex: index + 1 };
  }
  if (pattern[index + 2] === "/") {
    return { expression: "(?:.*/)?", nextIndex: index + 3 };
  }
  return { expression: ".*", nextIndex: index + 2 };
}

function readBracketToken(pattern: string, index: number): GlobToken {
  const closing = pattern.indexOf("]", index + 1);
  if (closing <= index + 1) {
    return { expression: escapeRegExp("["), nextIndex: index + 1 };
  }
  const contents = pattern.slice(index + 1, closing);
  const negated = contents.startsWith("!");
  const body = negated ? contents.slice(1) : contents;
  if (body.length === 0 || body.includes("/")) {
    return { expression: escapeRegExp("["), nextIndex: index + 1 };
  }
  return {
    expression: `[${negated ? "^" : ""}${body.replace(/\\/g, "\\\\")}]`,
    nextIndex: closing + 1,
  };
}

function readGlobToken(pattern: string, index: number): GlobToken {
  const character = pattern[index];
  if (character === "*") return readStarToken(pattern, index);
  if (character === "?") return { expression: "[^/]", nextIndex: index + 1 };
  if (character === "[") return readBracketToken(pattern, index);
  return {
    expression: escapeRegExp(character ?? ""),
    nextIndex: index + 1,
  };
}

function globRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length;) {
    const token = readGlobToken(pattern, index);
    expression += token.expression;
    index = token.nextIndex;
  }
  return new RegExp(`${expression}$`);
}

const matcherCache = new Map<string, RegExp>();

export function matchesGeneratedFileGlob(
  pattern: string,
  path: ConflictPath | string,
): boolean {
  let matcher = matcherCache.get(pattern);
  if (matcher === undefined) {
    matcher = globRegExp(pattern);
    matcherCache.set(pattern, matcher);
  }
  return matcher.test(path);
}

function isLiteralGlobSegment(segment: string): boolean {
  return (
    !segment.includes("?") && !segment.includes("*") && !segment.includes("[")
  );
}

function globSegmentsMayOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftLiteral = isLiteralGlobSegment(left);
  const rightLiteral = isLiteralGlobSegment(right);
  if (leftLiteral && rightLiteral) return false;
  if (leftLiteral) return matchesGeneratedFileGlob(right, left);
  if (rightLiteral) return matchesGeneratedFileGlob(left, right);
  // The supported wildcard forms can all accept at least one common
  // repository path segment. The matcher still performs the final path-level
  // selection, so this conservative result only rejects potentially
  // ambiguous static policies.
  return true;
}

function globOverlapTransitions(
  leftSegments: readonly string[],
  rightSegments: readonly string[],
  leftIndex: number,
  rightIndex: number,
): readonly [number, number][] {
  const leftSegment = leftSegments[leftIndex];
  const rightSegment = rightSegments[rightIndex];
  const transitions: [number, number][] = [];
  if (leftSegment === "**") transitions.push([leftIndex + 1, rightIndex]);
  if (rightSegment === "**") transitions.push([leftIndex, rightIndex + 1]);
  if (leftSegment === "**" && rightSegment !== undefined) {
    transitions.push([leftIndex, rightIndex + 1]);
  } else if (rightSegment === "**" && leftSegment !== undefined) {
    transitions.push([leftIndex + 1, rightIndex]);
  } else if (
    leftSegment !== undefined &&
    rightSegment !== undefined &&
    globSegmentsMayOverlap(leftSegment, rightSegment)
  ) {
    transitions.push([leftIndex + 1, rightIndex + 1]);
  }
  return transitions;
}

function globPatternsMayOverlap(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const pending: [number, number][] = [[0, 0]];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const state = pending.pop();
    if (state === undefined) continue;
    const [leftIndex, rightIndex] = state;
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (
      leftIndex === leftSegments.length &&
      rightIndex === rightSegments.length
    ) {
      return true;
    }
    pending.push(
      ...globOverlapTransitions(
        leftSegments,
        rightSegments,
        leftIndex,
        rightIndex,
      ),
    );
  }
  return false;
}

function assertConflictHandlerPolicy(policy: ConflictHandlersConfig): void {
  if (matchingGeneratedFileRules("pnpm-lock.yaml", policy).length > 0) {
    throw conflictHandlersError(
      "The built-in pnpm-lock.yaml handler cannot be overridden by policy.",
    );
  }
  for (let index = 0; index < policy.rules.length; index += 1) {
    const current = policy.rules[index];
    if (current === undefined) continue;
    for (
      let otherIndex = index + 1;
      otherIndex < policy.rules.length;
      otherIndex += 1
    ) {
      const other = policy.rules[otherIndex];
      if (
        other !== undefined &&
        globPatternsMayOverlap(current.match, other.match)
      ) {
        throw conflictHandlersError(
          `Conflict-handler rules have ambiguous match globs: ${current.match} and ${other.match}.`,
        );
      }
    }
  }
}

export interface GeneratedConflictGroup {
  readonly rule: ConflictHandlerRule;
  readonly conflicts: { path: ConflictPath; stage: 1 | 2 | 3 }[];
}

export function matchingGeneratedFileRules(
  path: ConflictPath,
  policy: ConflictHandlersConfig,
): readonly ConflictHandlerRule[] {
  return policy.rules.filter((rule) =>
    matchesGeneratedFileGlob(rule.match, path),
  );
}

export function assertSingleGeneratedFileRule(
  path: ConflictPath,
  rules: readonly ConflictHandlerRule[],
): ConflictHandlerRule | undefined {
  if (rules.length > 1) {
    throw conflictHandlersError(
      `Multiple generated-file handlers match conflict path: ${path}.`,
    );
  }
  return rules[0];
}

export function validateGeneratedOutputPath(
  path: ConflictPath,
  rule: ConflictHandlerRule,
): boolean {
  return rule.outputs.some((output) => matchesGeneratedFileGlob(output, path));
}
