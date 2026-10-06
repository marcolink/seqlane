import { z } from "zod";
import {
  reviewScopePathSchema,
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

/** Raw NUL records bind the patch to literal paths, including quoted filenames. */
export function parseScopedGitPatch(
  bytes: Uint8Array,
  expectedPath: string,
  evidenceForm: ReviewTreeChange["evidenceForm"] = "review-patch",
): {
  patch: string;
  hunkCount: number;
  treeChange: ReviewTreeChange;
} {
  const output = decodeGitBytes(bytes);
  const boundary = output.indexOf("\0\0");
  if (boundary < 0) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Scoped Git patch has no raw path record.",
    );
  }
  const fields = output.slice(0, boundary).split("\0");
  const header = rawHeaderSchema.parse(fields[0]);
  const path = reviewScopePathSchema.parse(fields[1]);
  if (fields.length !== 2 || path !== expectedPath) {
    throw new ReviewScopeError(
      "GIT_PATH_MISMATCH",
      "Scoped patch paths differ from selected paths.",
    );
  }
  const [oldMode, newMode, oldObjectId, newObjectId, status] = header
    .slice(1)
    .split(" ");
  const treeChange = reviewTreeChangeSchema.parse({
    path,
    evidenceForm,
    oldMode,
    newMode,
    oldObjectId,
    newObjectId,
    status,
  });
  const patch = output.slice(boundary + 2);
  if (!patch.startsWith("diff --git ") || !patch.endsWith("\n")) {
    throw new ReviewScopeError(
      "GIT_OUTPUT_MALFORMED",
      "Scoped Git patch is incomplete.",
    );
  }
  return {
    patch,
    hunkCount: [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm)]
      .length,
    treeChange,
  };
}
