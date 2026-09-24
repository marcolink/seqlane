import type {
  ClassifierQuestions,
  ClassifierResultFor,
  ClassifierState,
} from "./classifier.js";
import type { ClassifierRequestInput } from "./classifier.js";
import {
  classifierQuestionsSchema,
  createClassifierResultSchema,
} from "./classifier.js";
import type { TaskDefinition } from "./contracts.js";
import { taskDefinitionSchema } from "./contracts.js";
import { z } from "zod";

export interface ClassifierTaskDefinitionInput<
  Input,
  Questions extends ClassifierQuestions,
> {
  readonly id: string;
  readonly input: z.ZodType<Input>;
  readonly state: (input: Input) => ClassifierState;
  readonly questions: Questions;
  readonly execute?: never;
  readonly output?: never;
  readonly observability?: TaskDefinition["observability"];
}

export class MissingClassifierCapabilityError extends Error {
  constructor() {
    super("Classifier capability is not available in this task context");
    this.name = "MissingClassifierCapabilityError";
  }
}

/** Defines a task with dynamic state and fixed classifier questions. */
export function defineClassifierTask<
  Input,
  const Questions extends ClassifierQuestions,
>(
  definition: ClassifierTaskDefinitionInput<Input, ClassifierQuestions> & {
    readonly questions: Questions;
  } & (keyof Questions extends never
      ? { readonly classifierQuestionsCannotBeEmpty: never }
      : string extends keyof Questions
        ? { readonly classifierQuestionIdsMustBeFixed: never }
        : unknown),
): TaskDefinition<Input, ClassifierResultFor<Questions>> {
  if (Object.hasOwn(definition, "execute")) {
    throw new TypeError("defineClassifierTask does not accept execute");
  }
  if (Object.hasOwn(definition, "output")) {
    throw new TypeError("defineClassifierTask does not accept output");
  }

  const questions = classifierQuestionsSchema.parse(definition.questions);
  const output = createClassifierResultSchema(definition.questions);
  const task: TaskDefinition<Input, ClassifierResultFor<Questions>> = {
    id: definition.id,
    input: definition.input,
    output,
    ...(definition.observability === undefined
      ? {}
      : { observability: definition.observability }),
    execute: async ({ input, context }) => {
      if (context.classify === undefined) {
        throw new MissingClassifierCapabilityError();
      }
      const request: ClassifierRequestInput = {
        state: definition.state(input),
        questions,
      };
      return output.parse(await context.classify(request));
    },
  };
  taskDefinitionSchema.parse(task);
  return task;
}
