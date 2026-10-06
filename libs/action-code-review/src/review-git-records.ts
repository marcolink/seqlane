import { z } from "zod";
import {
  reviewScopePathSchema,
  reviewScopePathListSchema,
  reviewTreeChangeSchema,
  type ReviewTreeChange,
} from "./review-scope-contracts.js";
import { ReviewScopeError } from "./review-scope-errors.js";

const statusSchema = z.enum(["A", "D", "M", "T"]);
const rawHeaderSchema = z
  .string()
  .regex(
    /^:[0-7]{6} [0-7]{6} (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) [ADMT]$/,
  );

export function decodeGitBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Git output contains invalid UTF-8.",
      cause,
    );
  }
}

export function parseGitPaths(bytes: Uint8Array): string[] {
  if (bytes.length === 0) return [];
  const output = decodeGitBytes(bytes);
  if (!output.endsWith("\0")) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Git path records are incomplete.",
    );
  }
  const fields = output.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Git path record has no path.",
    );
  }
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    statusSchema.parse(fields[index]);
    paths.push(reviewScopePathSchema.parse(fields[index + 1]));
  }
  if (new Set(paths).size !== paths.length) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Git returned duplicate path records.",
    );
  }
  return paths;
}

function parseRawChanges(
  fields: string[],
  evidenceForm: ReviewTreeChange["evidenceForm"],
): ReviewTreeChange[] {
  if (fields.length % 2 !== 0) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Git raw records are incomplete.",
    );
  }
  const changes: ReviewTreeChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = rawHeaderSchema.parse(fields[index]);
    const [oldMode, newMode, oldObjectId, newObjectId, status] = header
      .slice(1)
      .split(" ");
    changes.push(
      reviewTreeChangeSchema.parse({
        path: fields[index + 1],
        evidenceForm,
        oldMode,
        newMode,
        oldObjectId,
        newObjectId,
        status,
      }),
    );
  }
  return changes;
}

// Matches Git's C quoting with core.quotePath=true and fixed a/ and b/ prefixes.
// Raw NUL records remain the authority for path identity; headers only delimit patches.
function quotedPatchPath(path: string): string {
  const escapes = new Map([
    [7, "\\a"],
    [8, "\\b"],
    [9, "\\t"],
    [10, "\\n"],
    [11, "\\v"],
    [12, "\\f"],
    [13, "\\r"],
    [34, '\\"'],
    [92, "\\\\"],
  ]);
  let quoted = false;
  const value = [...Buffer.from(path)]
    .map((byte) => {
      const escaped = escapes.get(byte);
      if (escaped !== undefined || byte < 32 || byte >= 127) {
        quoted = true;
        return escaped ?? `\\${byte.toString(8).padStart(3, "0")}`;
      }
      return String.fromCharCode(byte);
    })
    .join("");
  return quoted ? `"${value}"` : value;
}

function partitionPatches(patch: string, changes: ReviewTreeChange[]) {
  if (!patch.startsWith("diff --git ") || !patch.endsWith("\n")) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Scoped Git patch is incomplete.",
    );
  }
  const headers = new Map(
    changes.map((change) => [
      `diff --git ${quotedPatchPath(`a/${change.path}`)} ${quotedPatchPath(`b/${change.path}`)}\n`,
      change,
    ]),
  );
  const blocks = [...patch.matchAll(/^diff --git .*\n/gm)];
  const patches = new Map<string, string>();
  const splitTypeChanges = new Set<string>();
  let previousPath: string | undefined;
  for (const [index, block] of blocks.entries()) {
    const change = headers.get(block[0]);
    if (change === undefined) {
      throw new ReviewScopeError(
        "GIT_PATH_MISMATCH",
        "Patch header has no selected raw path.",
      );
    }
    const existing = patches.get(change.path);
    // A type change is rendered as adjacent deletion and addition blocks.
    if (
      existing !== undefined &&
      (change.status !== "T" ||
        previousPath !== change.path ||
        splitTypeChanges.has(change.path))
    ) {
      throw new ReviewScopeError(
        "GIT_PATH_MISMATCH",
        "Git returned duplicate patch paths.",
      );
    }
    if (existing !== undefined) splitTypeChanges.add(change.path);
    patches.set(
      change.path,
      (existing ?? "") + patch.slice(block.index, blocks[index + 1]?.index),
    );
    previousPath = change.path;
  }
  return changes
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    )
    .map((treeChange) => {
      const pathPatch = patches.get(treeChange.path);
      if (pathPatch === undefined) {
        throw new ReviewScopeError(
          "GIT_PATH_MISMATCH",
          "Git omitted a selected path patch.",
        );
      }
      return {
        patch: pathPatch,
        hunkCount: [
          ...pathPatch.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm),
        ].length,
        treeChange,
      };
    });
}

/** Bind complete multi-path patches to their raw NUL inventory, without line-splitting paths. */
export function parseScopedGitPatches(
  bytes: Uint8Array,
  expectedPathsValue: unknown,
  evidenceForm: ReviewTreeChange["evidenceForm"] = "pr-patch",
) {
  const expectedPaths = reviewScopePathListSchema.parse(expectedPathsValue);
  if (
    expectedPaths.length === 0 ||
    new Set(expectedPaths).size !== expectedPaths.length
  ) {
    throw new ReviewScopeError(
      "GIT_PATH_MISMATCH",
      "Scoped patch needs unique selected paths.",
    );
  }
  const output = decodeGitBytes(bytes);
  const boundary = output.indexOf("\0\0");
  if (boundary < 0) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Scoped Git patch has no raw path record.",
    );
  }
  const changes = parseRawChanges(
    output.slice(0, boundary).split("\0"),
    evidenceForm,
  );
  const paths = new Set(changes.map((change) => change.path));
  if (
    changes.length !== expectedPaths.length ||
    paths.size !== changes.length ||
    expectedPaths.some((path) => !paths.has(path))
  ) {
    throw new ReviewScopeError(
      "GIT_PATH_MISMATCH",
      "Scoped patch paths differ from selected paths.",
    );
  }
  return partitionPatches(output.slice(boundary + 2), changes);
}
