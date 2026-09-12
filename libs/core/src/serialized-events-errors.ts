import type { SeqlaneErrorCategory } from "./errors.js";
import type {
  SerializedSeqlaneError,
  SerializedValidationFailure,
  SerializeSeqlaneErrorOptions,
} from "./serialized-events.js";
import {
  hasNonEmptyString,
  isSeqlaneErrorCategory,
  isValidationIssue,
} from "./serialized-events.js";

function safeErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "Unknown Seqlane error";
  }
}

export function serializeSeqlaneError(
  cause: unknown,
  options: SerializeSeqlaneErrorOptions = {},
): SerializedSeqlaneError {
  let category: SeqlaneErrorCategory = "RuntimeError";
  let message = "Unknown Seqlane error";
  let taskId: string | undefined;
  let validation: SerializedValidationFailure | undefined;

  try {
    if (cause instanceof Error) {
      message = safeErrorMessage(cause.message);
      const error = cause as Error & {
        readonly category?: unknown;
        readonly taskId?: unknown;
        readonly nodeId?: unknown;
        readonly sourceId?: unknown;
        readonly issues?: unknown;
      };
      if (isSeqlaneErrorCategory(error.category)) category = error.category;
      if (hasNonEmptyString(error.taskId)) taskId = error.taskId;
      if (
        category === "ValidationError" &&
        hasNonEmptyString(error.nodeId) &&
        hasNonEmptyString(error.sourceId) &&
        Array.isArray(error.issues) &&
        error.issues.every(isValidationIssue)
      ) {
        validation = {
          validationNodeId: error.nodeId,
          sourceId: error.sourceId,
          issues: error.issues,
          ...(options.validationEvidence === undefined
            ? {}
            : { evidence: options.validationEvidence }),
        };
      }
    } else {
      message = safeErrorMessage(cause);
    }
  } catch {
    message = "Unknown Seqlane error";
  }

  return {
    category,
    message,
    ...(taskId === undefined ? {} : { taskId }),
    ...(validation === undefined ? {} : { validation }),
  };
}
