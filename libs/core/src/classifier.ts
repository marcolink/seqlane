import type { JsonValue, SeqlaneSchema } from "./contracts.js";
import { jsonValueSchema, plainRecordSchema } from "./json.js";
import { z } from "zod";

export const classifierQuestionKindSchema = z.enum(["choice", "score", "noul"]);

export type ClassifierQuestionKind = z.infer<
  typeof classifierQuestionKindSchema
>;

const classifierTextSchema = z.string().min(1);
const classifierIdSchema = z
  .string()
  .min(1)
  .max(256)
  .superRefine((id, context) => {
    if (new TextEncoder().encode(id).byteLength > 256) {
      context.addIssue({
        code: "custom",
        message: "Classifier IDs cannot exceed 256 UTF-8 bytes",
      });
    }
  });
const classifierInstructionSchema = z
  .string()
  .min(1)
  .superRefine((instructions, context) => {
    if (new TextEncoder().encode(instructions).byteLength > 64 * 1024) {
      context.addIssue({
        code: "custom",
        message: "Classifier instructions cannot exceed 64 KiB",
      });
    }
  });
const classifierDescriptionSchema = z
  .string()
  .min(1)
  .superRefine((description, context) => {
    if (new TextEncoder().encode(description).byteLength > 16 * 1024) {
      context.addIssue({
        code: "custom",
        message: "Classifier descriptions cannot exceed 16 KiB",
      });
    }
  });
const classifierCriteriaStringSchema = classifierDescriptionSchema;

const choiceCriteriaSchema = plainRecordSchema
  .pipe(z.record(classifierIdSchema, classifierCriteriaStringSchema))
  .superRefine((criteria, context) => {
    if (
      Object.keys(criteria).length < 2 ||
      Object.keys(criteria).length > 255
    ) {
      context.addIssue({
        code: "custom",
        message: "Choice needs 2 to 255 options",
      });
    }
  });

const scoreCriteriaSchema = z
  .array(classifierCriteriaStringSchema)
  .min(2)
  .max(10)
  .superRefine((criteria, context) => {
    if (new Set(criteria).size !== criteria.length) {
      context.addIssue({
        code: "custom",
        message: "Score levels must be distinct",
      });
    }
  });

const noulCriteriaSchema = z.strictObject({
  true: classifierDescriptionSchema,
  false: classifierDescriptionSchema,
});

const choiceQuestionInputSchema = z.strictObject({
  instructions: classifierInstructionSchema,
  criteria: choiceCriteriaSchema,
});
const scoreQuestionInputSchema = z.strictObject({
  instructions: classifierInstructionSchema,
  criteria: scoreCriteriaSchema,
});
const noulQuestionInputSchema = z.strictObject({
  instructions: classifierInstructionSchema,
  criteria: noulCriteriaSchema.optional(),
});
const classifierQuestionInputSchemaByKind = {
  choice: choiceQuestionInputSchema,
  score: scoreQuestionInputSchema,
  noul: noulQuestionInputSchema,
} satisfies Record<ClassifierQuestionKind, z.ZodType>;

export const classifierQuestionSchema = z.discriminatedUnion("kind", [
  choiceQuestionInputSchema.extend({ kind: z.literal("choice") }),
  scoreQuestionInputSchema.extend({ kind: z.literal("score") }),
  noulQuestionInputSchema.extend({ kind: z.literal("noul") }),
]);

export type ClassifierQuestion = z.output<typeof classifierQuestionSchema>;
export type ClassifierQuestionKinds = Readonly<
  Record<string, ClassifierQuestionKind>
>;

export type ClassifierQuestionFor<Kind extends ClassifierQuestionKind> =
  Kind extends "choice"
    ? Omit<Extract<ClassifierQuestion, { readonly kind: "choice" }>, "kind">
    : Kind extends "score"
      ? Omit<Extract<ClassifierQuestion, { readonly kind: "score" }>, "kind">
      : Omit<Extract<ClassifierQuestion, { readonly kind: "noul" }>, "kind">;

export type ClassifierRequestFor<Kinds extends ClassifierQuestionKinds> = {
  readonly state: JsonValue;
  readonly questions: {
    readonly [Id in keyof Kinds]: ClassifierQuestionFor<Kinds[Id]>;
  };
};

export type ClassifierRequest = {
  readonly state: JsonValue;
  readonly questions: Readonly<Record<string, ClassifierQuestion>>;
};

/** Runtime input accepted by TaskContext before its owning schema validates it. */
export type ClassifierRequestInput = {
  readonly state: JsonValue;
  readonly questions: Readonly<Record<string, unknown>>;
};

const classifierStateSchema = z.union([
  z.string(),
  z.array(jsonValueSchema),
  plainRecordSchema.pipe(z.record(z.string(), jsonValueSchema)),
]);

export const classifierRequestSchema = z
  .strictObject({
    state: classifierStateSchema,
    questions: plainRecordSchema.pipe(
      z.record(classifierIdSchema, classifierQuestionSchema),
    ),
  })
  .superRefine((request, context) => {
    const entries = Object.entries(request.questions);
    if (entries.length === 0 || entries.length > 256) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Classifier request needs 1 to 256 questions",
      });
    }
    for (const [id] of entries) {
      if (new TextEncoder().encode(id).byteLength > 256) {
        context.addIssue({
          code: "custom",
          path: ["questions", id],
          message: "Classifier question IDs cannot exceed 256 UTF-8 bytes",
        });
      }
    }
  });

const probabilitySchema = z.number().finite().min(0).max(1);
const extensionSchema = plainRecordSchema.pipe(
  z.record(z.string(), jsonValueSchema),
);

const probabilityDistributionSchema = plainRecordSchema
  .pipe(z.record(classifierIdSchema, probabilitySchema))
  .superRefine((distribution, context) => {
    const total = Object.values(distribution).reduce(
      (sum, probability) => sum + probability,
      0,
    );
    if (Object.keys(distribution).length === 0 || Math.abs(total - 1) > 0.001) {
      context.addIssue({
        code: "custom",
        message: "Probability distribution must sum to 1",
      });
    }
  });

const classifierAnswerShapeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("choice"),
    selected: classifierIdSchema,
    probabilities: probabilityDistributionSchema,
    confidence: probabilitySchema,
    extensions: extensionSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("score"),
    value: z.number().finite().nonnegative(),
    legend: plainRecordSchema.pipe(
      z.record(classifierIdSchema, classifierCriteriaStringSchema),
    ),
    probabilities: probabilityDistributionSchema,
    confidence: probabilitySchema,
    extensions: extensionSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("noul"),
    probability: probabilitySchema,
    extensions: extensionSchema.optional(),
  }),
]);

const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  extensions: extensionSchema.optional(),
});

export const classifierResultSchema = z.strictObject({
  model: classifierTextSchema,
  answers: plainRecordSchema.pipe(
    z.record(classifierIdSchema, classifierAnswerShapeSchema),
  ),
  usage: usageSchema,
  extensions: extensionSchema.optional(),
});

export type ClassifierAnswer = z.output<typeof classifierAnswerShapeSchema>;
export type ClassifierUsage = z.output<typeof usageSchema>;
export type ClassifierResult = z.output<typeof classifierResultSchema>;

export type ClassifierAnswerFor<Kind extends ClassifierQuestionKind> = Extract<
  ClassifierAnswer,
  { readonly kind: Kind }
>;

export type ClassifierResultFor<Kinds extends ClassifierQuestionKinds> = Omit<
  ClassifierResult,
  "answers"
> & {
  readonly answers: {
    readonly [Id in keyof Kinds]: ClassifierAnswerFor<Kinds[Id]>;
  };
};

export function createClassifierResultSchema<
  Kinds extends ClassifierQuestionKinds,
>(questionKinds: Kinds): SeqlaneSchema<ClassifierResultFor<Kinds>> {
  const fixedKindsResultSchema = classifierResultSchema.superRefine(
    (result, context) => {
      const declaredIds = Object.keys(questionKinds).sort();
      const answerIds = Object.keys(result.answers).sort();
      if (
        declaredIds.length !== answerIds.length ||
        declaredIds.some((id, index) => id !== answerIds[index])
      ) {
        context.addIssue({
          code: "custom",
          path: ["answers"],
          message: "Classifier answer IDs must match the declared questions",
        });
        return;
      }
      for (const id of declaredIds) {
        const answer = result.answers[id];
        if (answer === undefined || answer.kind !== questionKinds[id]) {
          context.addIssue({
            code: "custom",
            path: ["answers", id, "kind"],
            message: "Classifier answer kind must match its declaration",
          });
        }
      }
    },
  );
  return z.custom<ClassifierResultFor<Kinds>>((value) => {
    const parsedKinds = z
      .record(classifierIdSchema, classifierQuestionKindSchema)
      .safeParse(questionKinds);
    if (!parsedKinds.success || Object.keys(questionKinds).length === 0) {
      return false;
    }
    const parsedResult = fixedKindsResultSchema.safeParse(value);
    if (!parsedResult.success) return false;
    const declaredIds = Object.keys(questionKinds).sort();
    return declaredIds.every((id) => {
      const answer = parsedResult.data.answers[id];
      return answer !== undefined && answer.kind === questionKinds[id];
    });
  });
}

export function classifierRequestSchemaFor<
  Kinds extends ClassifierQuestionKinds,
>(questionKinds: Kinds): SeqlaneSchema<ClassifierRequestFor<Kinds>> {
  const parsedKinds = z
    .record(classifierIdSchema, classifierQuestionKindSchema)
    .safeParse(questionKinds);
  if (
    !parsedKinds.success ||
    Object.keys(parsedKinds.data).length === 0 ||
    Object.keys(parsedKinds.data).length > 256
  ) {
    return z.custom<ClassifierRequestFor<Kinds>>(() => false);
  }
  const questionsShape = Object.fromEntries(
    Object.entries(parsedKinds.data).map(([id, kind]) => [
      id,
      classifierQuestionInputSchemaByKind[kind],
    ]),
  );
  const fixedBuilderRequestSchema = z.strictObject({
    // Runtime owns bounded JSON preflight before recursive state validation.
    state: z.unknown(),
    questions: z.strictObject(questionsShape),
  });
  return z.custom<ClassifierRequestFor<Kinds>>((value) => {
    return fixedBuilderRequestSchema.safeParse(value).success;
  });
}
