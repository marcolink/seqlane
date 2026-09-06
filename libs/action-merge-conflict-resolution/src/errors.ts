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

export type ResolutionErrorCode =
  | "INVALID_ACTION_INPUT"
  | "INVALID_REQUEST"
  | "PULL_REQUEST_NOT_OPEN"
  | "FORK_PULL_REQUEST"
  | "MALFORMED_PULL_REQUEST"
  | "PRE_EXISTING_OPERATION"
  | "GIT_OPERATION_FAILED"
  | "CONFLICT_SET_REQUIRED"
  | "UNSAFE_PATH"
  | "UNSUPPORTED_AGENT_FILE"
  | "WORKSPACE_LIMIT_EXCEEDED"
  | "UNEXPECTED_TARGET_CHANGE"
  | "UNRESOLVED_CONFLICT"
  | "CONFLICT_MARKER_REMAINS"
  | "LOCKFILE_REGENERATION_FAILED"
  | "AGENT_FAILED"
  | "ATTEMPT_LIMIT_EXCEEDED"
  | "REMOTE_BASE_CHANGED"
  | "REMOTE_HEAD_CHANGED"
  | "PUSH_REFUSED"
  | "OPERATION_FAILED";

export const resolutionErrorCodeSchema = z.enum([
  "INVALID_ACTION_INPUT",
  "INVALID_REQUEST",
  "PULL_REQUEST_NOT_OPEN",
  "FORK_PULL_REQUEST",
  "MALFORMED_PULL_REQUEST",
  "PRE_EXISTING_OPERATION",
  "GIT_OPERATION_FAILED",
  "CONFLICT_SET_REQUIRED",
  "UNSAFE_PATH",
  "UNSUPPORTED_AGENT_FILE",
  "WORKSPACE_LIMIT_EXCEEDED",
  "UNEXPECTED_TARGET_CHANGE",
  "UNRESOLVED_CONFLICT",
  "CONFLICT_MARKER_REMAINS",
  "LOCKFILE_REGENERATION_FAILED",
  "AGENT_FAILED",
  "ATTEMPT_LIMIT_EXCEEDED",
  "REMOTE_BASE_CHANGED",
  "REMOTE_HEAD_CHANGED",
  "PUSH_REFUSED",
  "OPERATION_FAILED",
]);

export const resolutionErrorDetailsSchema = z.strictObject({
  category: resolutionErrorCategorySchema,
  code: resolutionErrorCodeSchema,
});
export type ResolutionErrorDetails = z.infer<
  typeof resolutionErrorDetailsSchema
>;

export class ActionResolutionError extends Error {
  constructor(
    readonly category: ResolutionErrorCategory,
    readonly code: ResolutionErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ActionResolutionError";
  }
}

export function resolutionErrorDetails(error: ActionResolutionError): {
  readonly category: ResolutionErrorCategory;
  readonly code: ResolutionErrorCode;
} {
  return { category: error.category, code: error.code };
}
