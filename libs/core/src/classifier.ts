import type { SeqlaneSchema } from "./contracts.js";
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
export const classifierQuestionSchema = z.discriminatedUnion("kind", [
  choiceQuestionInputSchema.extend({ kind: z.literal("choice") }),
  scoreQuestionInputSchema.extend({ kind: z.literal("score") }),
  noulQuestionInputSchema.extend({ kind: z.literal("noul") }),
]);

export type ClassifierQuestion = z.output<typeof classifierQuestionSchema>;

export const classifierQuestionsSchema = plainRecordSchema
  .pipe(z.record(classifierIdSchema, classifierQuestionSchema))
  .superRefine((questions, context) => {
    const count = Object.keys(questions).length;
    if (count === 0 || count > 256) {
      context.addIssue({
        code: "custom",
        message: "Declare between 1 and 256 classifier questions",
      });
    }
  });

export type ClassifierQuestions = z.output<typeof classifierQuestionsSchema>;

export const classifierStateSchema = z.union([
  z.string(),
  z.array(jsonValueSchema),
  plainRecordSchema.pipe(z.record(z.string(), jsonValueSchema)),
]);

export type ClassifierState = z.output<typeof classifierStateSchema>;

export type ClassifierRequest = {
  readonly state: ClassifierState;
  readonly questions: ClassifierQuestions;
};

/** Runtime input accepted by TaskContext before its owning schema validates it. */
export type ClassifierRequestInput = {
  readonly state: ClassifierState;
  readonly questions: Readonly<Record<string, unknown>>;
};

export const classifierRequestSchema = z.strictObject({
  state: classifierStateSchema,
  questions: classifierQuestionsSchema,
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

export type ClassifierResultFor<Questions extends ClassifierQuestions> = Omit<
  ClassifierResult,
  "answers"
> & {
  readonly answers: {
    readonly [Id in keyof Questions]: ClassifierAnswerFor<
      Questions[Id]["kind"]
    >;
  };
};

export function createClassifierResultSchema<
  Questions extends ClassifierQuestions,
>(questions: Questions): SeqlaneSchema<ClassifierResultFor<Questions>> {
  const declaredQuestions = classifierQuestionsSchema.parse(questions);
  const fixedKindsResultSchema = classifierResultSchema.superRefine(
    (result, context) => {
      const declaredIds = Object.keys(declaredQuestions).sort();
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
        if (
          answer === undefined ||
          answer.kind !== declaredQuestions[id]?.kind
        ) {
          context.addIssue({
            code: "custom",
            path: ["answers", id, "kind"],
            message: "Classifier answer kind must match its declaration",
          });
        }
      }
    },
  );
  return z.custom<ClassifierResultFor<Questions>>((value) => {
    const parsedResult = fixedKindsResultSchema.safeParse(value);
    if (!parsedResult.success) return false;
    const declaredIds = Object.keys(declaredQuestions).sort();
    return declaredIds.every((id) => {
      const answer = parsedResult.data.answers[id];
      return (
        answer !== undefined && answer.kind === declaredQuestions[id]?.kind
      );
    });
  });
}
