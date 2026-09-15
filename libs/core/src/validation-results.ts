import { jsonValueSchema } from "./json.js";
import { z } from "zod";

const jsonEvidencePresenceSchema = z.unknown().transform((value, context) => {
  if (typeof value !== "object" || value === null) return value;

  try {
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        value: descriptor.value,
        writable: true,
      });
    }

    const evidence = Object.getOwnPropertyDescriptor(value, "evidence");
    if (
      evidence !== undefined &&
      (!("value" in evidence) ||
        !jsonValueSchema.safeParse(evidence.value).success)
    ) {
      context.addIssue({
        code: "custom",
        message: "Validation evidence must be JSON-safe",
      });
      return z.NEVER;
    }
    return snapshot;
  } catch {
    context.addIssue({
      code: "custom",
      message: "Validation evidence must be JSON-safe",
    });
    return z.NEVER;
  }
});

export const validationIssueSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});

const validationResultShapeSchema = z.discriminatedUnion("success", [
  z.looseObject({
    success: z.literal(true),
    evidence: jsonValueSchema.optional(),
  }),
  z.looseObject({
    success: z.literal(false),
    issues: z
      .array(validationIssueSchema)
      .nonempty("A failed validation result must contain at least one issue")
      .readonly(),
    evidence: jsonValueSchema.optional(),
  }),
]);

export const validationResultSchema = jsonEvidencePresenceSchema.pipe(
  validationResultShapeSchema,
);

export type ValidationIssue = z.output<typeof validationIssueSchema>;
export type ValidationResult = z.output<typeof validationResultSchema>;
