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

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function choiceAnswerIssues(
  id: string,
  question: Extract<ClassifierQuestion, { kind: "choice" }>,
  answer: Extract<ClassifierAnswer, { kind: "choice" }>,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const optionIds = Object.keys(question.criteria);
  if (!optionIds.includes(answer.selected)) {
    issues.push({
      path: ["answers", id, "selected"],
      message: "Choice selection must match a declared option",
    });
  }
  if (!hasExactKeys(answer.probabilities, optionIds)) {
    issues.push({
      path: ["answers", id, "probabilities"],
      message: "Choice probabilities must match the declared options",
    });
  }
  return issues;
}

function scoreAnswerIssues(
  id: string,
  question: Extract<ClassifierQuestion, { kind: "score" }>,
  answer: Extract<ClassifierAnswer, { kind: "score" }>,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const levelKeys = question.criteria.map((_level, index) => String(index));
  const expectedLegend = Object.fromEntries(
    question.criteria.map((level, index) => [String(index), level]),
  );
  if (answer.value > question.criteria.length - 1) {
    issues.push({
      path: ["answers", id, "value"],
      message: "Score value must be within the declared levels",
    });
  }
  if (
    !hasExactKeys(answer.legend, levelKeys) ||
    levelKeys.some((key) => answer.legend[key] !== expectedLegend[key])
  ) {
    issues.push({
      path: ["answers", id, "legend"],
      message: "Score legend must match the declared levels",
    });
  }
  if (!hasExactKeys(answer.probabilities, levelKeys)) {
    issues.push({
      path: ["answers", id, "probabilities"],
      message: "Score probabilities must match the declared levels",
    });
  }
  return issues;
}

function answerCriteriaIssues(
  id: string,
  question: ClassifierQuestion,
  answer: ClassifierAnswer,
): { path: (string | number)[]; message: string }[] {
  if (answer.kind !== question.kind) {
    return [
      {
        path: ["answers", id, "kind"],
        message: "Classifier answer kind must match its declaration",
      },
    ];
  }
  if (question.kind === "choice" && answer.kind === "choice") {
    return choiceAnswerIssues(id, question, answer);
  }
  if (question.kind === "score" && answer.kind === "score") {
    return scoreAnswerIssues(id, question, answer);
  }
  return [];
}

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
        const question = declaredQuestions[id];
        if (answer === undefined || question === undefined) {
          continue;
        }
        for (const issue of answerCriteriaIssues(id, question, answer)) {
          context.addIssue({
            code: "custom",
            path: issue.path,
            message: issue.message,
          });
        }
      }
    },
  );
  // The refinement proves the fixed answer keys and kinds at runtime. The
  // no-op schema gives that runtime proof its narrower static output type.
  return fixedKindsResultSchema.pipe(
    z.custom<ClassifierResultFor<Questions>>(),
  );
}
