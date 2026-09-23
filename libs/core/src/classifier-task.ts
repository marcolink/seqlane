import type {
  ClassifierQuestionKinds,
  ClassifierRequestFor,
  ClassifierResultFor,
} from "./classifier.js";
import type { ClassifierRequestInput } from "./classifier.js";
import {
  classifierRequestSchemaFor,
  classifierQuestionKindSchema,
  createClassifierResultSchema,
} from "./classifier.js";
import type { TaskDefinition } from "./contracts.js";
import { taskDefinitionSchema } from "./contracts.js";
import { z } from "zod";

export interface ClassifierTaskDefinitionInput<
  Input,
  Kinds extends ClassifierQuestionKinds,
> {
  readonly id: string;
  readonly input: z.ZodType<Input>;
  readonly questionKinds: Kinds;
  readonly build: (input: Input) => ClassifierRequestFor<Kinds>;
  readonly execute?: never;
  readonly output?: never;
  readonly observability?: TaskDefinition["observability"];
}

const classifierQuestionKindsSchema = z
  .record(z.string().min(1), classifierQuestionKindSchema)
  .superRefine((questionKinds, context) => {
    const ids = Object.keys(questionKinds);
    if (ids.length === 0 || ids.length > 256) {
      context.addIssue({
        code: "custom",
        message: "Declare between 1 and 256 classifier questions",
      });
    }
    for (const id of ids) {
      if (new TextEncoder().encode(id).byteLength > 256) {
        context.addIssue({
          code: "custom",
          path: [id],
          message: "Classifier question IDs cannot exceed 256 UTF-8 bytes",
        });
      }
    }
  });

/** Defines a task whose fixed question kinds are resolved for each input. */
export function defineClassifierTask<
  Input,
  Kinds extends ClassifierQuestionKinds,
>(
  definition: ClassifierTaskDefinitionInput<Input, Kinds>,
): TaskDefinition<Input, ClassifierResultFor<Kinds>> {
  if (Object.hasOwn(definition, "execute")) {
    throw new TypeError("defineClassifierTask does not accept execute");
  }
  if (Object.hasOwn(definition, "output")) {
    throw new TypeError("defineClassifierTask does not accept output");
  }

  classifierQuestionKindsSchema.parse(definition.questionKinds);
  const questionKinds = definition.questionKinds;
  const builderRequestSchema = classifierRequestSchemaFor(questionKinds);
  const output = createClassifierResultSchema(questionKinds);
  const task: TaskDefinition<Input, ClassifierResultFor<Kinds>> = {
    id: definition.id,
    input: definition.input,
    output,
    ...(definition.observability === undefined
      ? {}
      : { observability: definition.observability }),
    execute: async ({ input, context }) => {
      const built = builderRequestSchema.parse(definition.build(input));
      const questions = Object.fromEntries(
        Object.entries(questionKinds).map(([id, kind]) => {
          const question = built.questions[id as keyof Kinds];
          return [id, { ...question, kind }];
        }),
      );
      const request: ClassifierRequestInput = {
        state: built.state,
        questions,
      };
      return output.parse(await context.classify(request));
    },
  };
  taskDefinitionSchema.parse(task);
  return task;
}
