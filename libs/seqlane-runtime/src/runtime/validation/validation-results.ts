import type {
  ValidationCheckNode,
  ValidationGateNode,
} from "@seqlane/core";
import {
  ValidationFailedError,
  jsonValueSchema,
} from "@seqlane/core";
import { z } from "zod";

const validationIssueSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});

const jsonEvidencePresenceSchema = z.custom<unknown>((value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, "evidence")
  ) {
    return true;
  }
  return jsonValueSchema.safeParse(Reflect.get(value, "evidence")).success;
});

const passedValidationResultShapeSchema = z.looseObject({
  success: z.literal(true),
  evidence: jsonValueSchema.optional(),
});

const failedValidationResultShapeSchema = z.looseObject({
  success: z.literal(false),
  issues: z.array(validationIssueSchema).nonempty(),
  evidence: jsonValueSchema.optional(),
});

const passedValidationResultSchema = jsonEvidencePresenceSchema.pipe(
  passedValidationResultShapeSchema,
);
const failedValidationResultSchema = jsonEvidencePresenceSchema.pipe(
  failedValidationResultShapeSchema,
);

const validationResultSchema = z.union([
  passedValidationResultSchema,
  failedValidationResultSchema,
]);

const validationResultObjectSchema = z.looseObject({});
const passedValidationShapeSchema = z.looseObject({
  success: z.literal(true),
});
const failedValidationShapeSchema = z.looseObject({
  success: z.literal(false),
  issues: z.array(z.unknown()),
});

export type RuntimeValidationResult = z.infer<typeof validationResultSchema>;

export function parseValidationResult(
  value: unknown,
): RuntimeValidationResult {
  if (!validationResultObjectSchema.safeParse(value).success) {
    throw new Error("Validation result must be a JSON object");
  }

  const passedShape = passedValidationShapeSchema.safeParse(value);
  if (passedShape.success) {
    const passedResult = passedValidationResultSchema.safeParse(value);
    if (!passedResult.success) {
      throw new Error("Validation evidence must be JSON-safe");
    }
    return passedResult.data;
  }

  const failedShape = failedValidationShapeSchema.safeParse(value);
  if (!failedShape.success) {
    throw new Error(
      "Validation result must have success true or success false with issues",
    );
  }
  if (failedShape.data.issues.length === 0) {
    throw new Error(
      "A failed validation result must contain at least one issue",
    );
  }
  if (
    !z.array(validationIssueSchema).safeParse(failedShape.data.issues)
      .success
  ) {
    throw new Error("Validation issues must contain code and message strings");
  }

  const failedResult = validationResultSchema.safeParse(value);
  if (!failedResult.success) {
    throw new Error("Validation evidence must be JSON-safe");
  }
  return failedResult.data;
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
