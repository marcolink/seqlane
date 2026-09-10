import { z } from "zod";

export const resolutionErrorCategories = [
  "input-validation",
  "pull-request-preflight",
  "git",
  "workspace",
  "lockfile",
  "agent",
  "validation",
  "attempt-limit",
  "remote-race",
  "push",
  "operational",
] as const;

export const resolutionErrorCategorySchema = z.enum(resolutionErrorCategories);

export type ResolutionErrorCategory =
  (typeof resolutionErrorCategories)[number];

export const resolutionErrorCodeSchema = z.enum([
  "INVALID_ACTION_INPUT",
  "PUSH_TOKEN_REQUIRED",
  "INVALID_REQUEST",
  "CONFLICT_HANDLERS_INVALID",
  "PULL_REQUEST_NOT_OPEN",
  "FORK_PULL_REQUEST",
  "MALFORMED_PULL_REQUEST",
  "PRE_EXISTING_OPERATION",
  "WORKTREE_NOT_CLEAN",
  "GIT_OPERATION_FAILED",
  "GIT_OUTPUT_MALFORMED",
  "CONFLICT_SET_REQUIRED",
  "UNSAFE_PATH",
  "UNSUPPORTED_AGENT_FILE",
  "WORKSPACE_LIMIT_EXCEEDED",
  "UNEXPECTED_TARGET_CHANGE",
  "UNRESOLVED_CONFLICT",
  "CONFLICT_MARKER_REMAINS",
  "STAGED_WHITESPACE_ERROR",
  "LOCKFILE_REGENERATION_FAILED",
  "CONFLICT_HANDLER_FAILED",
  "AGENT_FAILED",
  "ATTEMPT_LIMIT_EXCEEDED",
  "REMOTE_BASE_CHANGED",
  "REMOTE_HEAD_CHANGED",
  "PUSH_REFUSED",
  "OPERATION_FAILED",
]);
export type ResolutionErrorCode = z.infer<typeof resolutionErrorCodeSchema>;

export const resolutionErrorDetailsSchema = z.strictObject({
  category: resolutionErrorCategorySchema,
  code: resolutionErrorCodeSchema,
  diagnostic: z.string().min(1).max(1_025).optional(),
});
export type ResolutionErrorDetails = z.infer<
  typeof resolutionErrorDetailsSchema
>;

export class ActionResolutionError extends Error {
  readonly category: ResolutionErrorCategory;
  readonly code: ResolutionErrorCode;

  constructor(
    category: ResolutionErrorCategory,
    code: ResolutionErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ActionResolutionError";
    this.category = category;
    this.code = code;
  }
}

const MAX_PUSH_DIAGNOSTIC_LENGTH = 1_024;
const MAX_WORKSPACE_DIAGNOSTIC_LENGTH = 1_024;
export type WorkspaceLimitUnit = "bytes" | "files";
export interface WorkspaceLimitDiagnosticOptions {
  readonly path?: string;
  readonly observed: number;
  readonly limit: number;
  readonly unit: WorkspaceLimitUnit;
  readonly aggregate?: {
    readonly offendingFileBytes: number;
    readonly accumulatedBytes: number;
  };
}
const pushFailureCauseSchema = z.looseObject({
  stderr: z.string().min(1),
});
const ansiCsiSequence = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
      ? " "
      : character;
  }).join("");
}

export function formatWorkspaceLimitDiagnostic(
  prefix: string,
  options: WorkspaceLimitDiagnosticOptions,
): string {
  const pathPrefix = options.path === undefined ? "" : ": ";
  const suffix =
    options.aggregate === undefined
      ? ` (observed ${options.observed} ${options.unit} > ${options.limit} ${options.unit}).`
      : ` (offending file ${options.aggregate.offendingFileBytes} bytes; accumulated ${options.aggregate.accumulatedBytes} bytes; aggregate limit ${options.limit} bytes; resulting total ${options.observed} bytes).`;
  const availablePathLength =
    MAX_WORKSPACE_DIAGNOSTIC_LENGTH -
    prefix.length -
    pathPrefix.length -
    suffix.length;
  const sanitizedPath =
    options.path === undefined
      ? ""
      : replaceControlCharacters(options.path).replace(/\s+/g, " ").trim();
  const boundedPath =
    options.path === undefined
      ? ""
      : sanitizedPath.length > availablePathLength
        ? `${sanitizedPath.slice(0, Math.max(0, availablePathLength - 1))}…`
        : sanitizedPath;
  return `${prefix}${pathPrefix}${boundedPath}${suffix}`;
}

function boundedPushDiagnostic(cause: unknown): string | undefined {
  const parsed = pushFailureCauseSchema.safeParse(cause);
  if (!parsed.success) return undefined;

  const sanitized = replaceControlCharacters(
    parsed.data.stderr.replace(ansiCsiSequence, ""),
  )
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.length > MAX_PUSH_DIAGNOSTIC_LENGTH
    ? `${sanitized.slice(0, MAX_PUSH_DIAGNOSTIC_LENGTH)}…`
    : sanitized;
}

function boundedWorkspaceDiagnostic(
  error: ActionResolutionError,
): string | undefined {
  const sanitized = replaceControlCharacters(error.message)
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.length > MAX_WORKSPACE_DIAGNOSTIC_LENGTH
    ? `${sanitized.slice(0, MAX_WORKSPACE_DIAGNOSTIC_LENGTH)}…`
    : sanitized;
}

export function resolutionErrorDetails(
  error: ActionResolutionError,
): ResolutionErrorDetails {
  const diagnostic =
    error.category === "push" && error.code === "PUSH_REFUSED"
      ? boundedPushDiagnostic(error.cause)
      : error.category === "workspace" &&
          error.code === "WORKSPACE_LIMIT_EXCEEDED"
        ? boundedWorkspaceDiagnostic(error)
        : undefined;
  return diagnostic === undefined
    ? { category: error.category, code: error.code }
    : { category: error.category, code: error.code, diagnostic };
}
