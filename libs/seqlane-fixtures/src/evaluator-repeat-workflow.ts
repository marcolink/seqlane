import { createFlow, defineTask, validatedBy } from "@seqlane/core";
import { z } from "zod";

const repeatInputSchema = z.object({ seed: z.string() });
const repeatStateSchema = z.object({
  value: z.string(),
  attempt: z.number(),
});

const validationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});

const validationResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    evidence: z.json().optional(),
  }),
  z.object({
    success: z.literal(false),
    issues: z.tuple([validationIssueSchema]).rest(validationIssueSchema),
    evidence: z.json().optional(),
  }),
]);

const repairTask = defineTask({
  id: "validation.fixture.repair",
  workspace: "shared",
  input: repeatStateSchema,
  output: repeatStateSchema,
  goal: ({ value }) => `Repair ${value}.`,
});

const evaluatorTask = defineTask({
  id: "validation.fixture.evaluator",
  workspace: "shared",
  input: repeatStateSchema,
  output: validationResultSchema,
  goal: ({ value }) => `Evaluate whether ${value} is ready.`,
});

export const evaluatorRepeatWorkflow = createFlow({
  id: "validation-fixture-evaluator-repeat",
  input: repeatInputSchema,
  output: repeatStateSchema,
})
  .repeat("repair", {
    initial: ({ input }) => ({ value: input.seed, attempt: 0 }),
    body: ({ input, task }) => task(repairTask, { input }).output,
    until: validatedBy(evaluatorTask),
    maximumIterations: 3,
  })
  .output(({ tasks }) => tasks.repair.output)
  .define();
