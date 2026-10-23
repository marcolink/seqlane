import { InputValidationError } from "@seqlane/core";

/** Marks the one input-validation failure that the public run facade wraps. */
export class WorkflowInputValidationError extends InputValidationError {}

export function isWorkflowInputValidationError(
  error: unknown,
): error is WorkflowInputValidationError {
  return error instanceof WorkflowInputValidationError;
}
