import { z } from "zod";
import type { ReadonlySchemaOutput } from "./validation.js";

const reservedIds = new Set(["__proto__", "prototype", "constructor"]);
const inputIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine((value) => !reservedIds.has(value));
const nonBlank = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);

export const userInputOptionSchema = z.strictObject({
  value: inputIdSchema,
  label: nonBlank(256),
});

export const userInputQuestionSchema = z
  .strictObject({
    id: inputIdSchema,
    prompt: nonBlank(4096),
    options: z.array(userInputOptionSchema).min(1).max(20).optional(),
    allowFreeText: z.boolean(),
  })
  .superRefine((question, context) => {
    if (question.options === undefined && !question.allowFreeText) {
      context.addIssue({
        code: "custom",
        message: "A text question must allow free text",
      });
    }
    const values = question.options?.map(({ value }) => value) ?? [];
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "Option values must be unique",
      });
    }
  });

export const userInputQuestionsSchema = z
  .array(userInputQuestionSchema)
  .min(1)
  .max(8)
  .superRefine((questions, context) => {
    if (new Set(questions.map(({ id }) => id)).size !== questions.length) {
      context.addIssue({
        code: "custom",
        message: "Question IDs must be unique",
      });
    }
  });

/** Bounds the complete serialized input message, including its envelope. */
export function boundedUserInputSchema<T extends z.ZodType>(schema: T) {
  return schema.superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      64 * 1024
    ) {
      context.addIssue({
        code: "custom",
        message: "User input exceeds 64 KiB",
      });
    }
  });
}

export const userInputRequestSchema = boundedUserInputSchema(
  z.strictObject({
    questions: userInputQuestionsSchema,
  }),
);

export const userInputAnswersSchema = z.record(
  inputIdSchema,
  z.string().min(1).max(8192),
);

export const userInputAnswerSchema = z.strictObject({
  status: z.literal("answered"),
  answers: userInputAnswersSchema,
});

export const interactionPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("disabled") }),
  z.strictObject({
    mode: z.literal("user-input"),
    timeoutMs: z.number().int().min(1_000).max(86_400_000),
  }),
]);

export type UserInputRequest = ReadonlySchemaOutput<
  typeof userInputRequestSchema
>;
export type UserInputAnswer = z.output<typeof userInputAnswerSchema>;
export type InteractionPolicy = z.output<typeof interactionPolicySchema>;

export function userInputAnswersForRequestSchema(request: UserInputRequest) {
  return userInputAnswersSchema.superRefine((answers, context) => {
    const expectedIds = request.questions.map(({ id }) => id).sort();
    if (
      JSON.stringify(Object.keys(answers).sort()) !==
      JSON.stringify(expectedIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "Answer every question exactly once",
      });
      return;
    }
    for (const question of request.questions) {
      const answer = answers[question.id];
      if (answer === undefined || answer.trim().length === 0) {
        context.addIssue({
          code: "custom",
          path: [question.id],
          message: "An answer is required",
        });
      } else if (
        question.options !== undefined &&
        !question.allowFreeText &&
        !question.options.some(({ value }) => value === answer)
      ) {
        context.addIssue({
          code: "custom",
          path: [question.id],
          message: "Select an offered option",
        });
      }
    }
  });
}
