import { z } from "zod";

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export type ModelRef<
  Provider extends string = string,
  Model extends string = string,
> = Readonly<{
  provider: Provider;
  model: Model;
}>;

export const modelRefSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict()
  .readonly();

export type ModelSelection<
  Provider extends string = string,
  Model extends string = string,
> = Readonly<{
  model: ModelRef<Provider, Model>;
  reasoning?: ReasoningEffort;
}>;

export const modelSelectionSchema = z
  .object({
    model: modelRefSchema,
    reasoning: reasoningEffortSchema.optional(),
  })
  .strict()
  .readonly();
