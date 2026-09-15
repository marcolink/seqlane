import type { SeqlaneErrorCategory } from "@seqlane/core";
import type {
  SerializedSeqlaneError,
  SerializedValidationFailure,
  SerializeSeqlaneErrorOptions,
} from "./contracts.js";
import { seqlaneErrorMetadataSchema } from "./validation.js";
import { z } from "zod";

function validationMetadata(
  category: SeqlaneErrorCategory,
  metadata: z.output<typeof seqlaneErrorMetadataSchema>,
  options: SerializeSeqlaneErrorOptions,
): SerializedValidationFailure | undefined {
  if (
    category !== "ValidationError" ||
    metadata.nodeId === undefined ||
    metadata.sourceId === undefined ||
    metadata.issues === undefined
  ) {
    return undefined;
  }
  return {
    validationNodeId: metadata.nodeId,
    sourceId: metadata.sourceId,
    issues: metadata.issues,
    ...(options.validationEvidence === undefined
      ? {}
      : { evidence: options.validationEvidence }),
  };
}

/** Return a stable message for an arbitrary thrown value. */
export function safeErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    try {
      return safeErrorMessage(value.message);
    } catch {
      return "Unknown Seqlane error";
    }
  }
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
      const metadata = seqlaneErrorMetadataSchema.safeParse(cause);
      if (metadata.success) {
        category = metadata.data.category ?? category;
        taskId = metadata.data.taskId;
        validation = validationMetadata(category, metadata.data, options);
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
