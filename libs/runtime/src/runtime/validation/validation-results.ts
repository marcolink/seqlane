import {
  ValidationFailedError,
  validationResultSchema,
  type ValidationCheckNode,
  type ValidationGateNode,
  type ValidationResult,
} from "@seqlane/core";

export type RuntimeValidationResult = ValidationResult;

export function parseValidationResult(value: unknown): RuntimeValidationResult {
  const result = validationResultSchema.safeParse(value);
  if (result.success) return result.data;

  if (
    result.error.issues.some(
      (issue) => issue.code === "custom" && issue.path.length === 0,
    )
  ) {
    throw new Error("Validation evidence must be JSON-safe");
  }
  if (
    result.error.issues.some(
      (issue) =>
        issue.code === "too_small" &&
        issue.path.length === 1 &&
        issue.path[0] === "issues",
    )
  ) {
    throw new Error(
      "A failed validation result must contain at least one issue",
    );
  }
  throw new Error(
    "Validation result must have success true or success false with issues",
  );
}

function validationSourceId(node: ValidationCheckNode): string {
  return node.source.type === "mechanical"
    ? node.source.validatorId
    : node.source.taskId;
}

export function validationFailure(
  node: ValidationGateNode,
  check: ValidationCheckNode,
  result: Extract<RuntimeValidationResult, { success: false }>,
): ValidationFailedError {
  return new ValidationFailedError(
    node.nodeId,
    validationSourceId(check),
    result.issues,
    result.evidence,
  );
}
