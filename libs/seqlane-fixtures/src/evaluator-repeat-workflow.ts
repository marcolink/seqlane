import { createFlow, defineAgentTask, validatedBy } from "@seqlane/core";
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

const repairTask = defineAgentTask({
  id: "validation.fixture.repair",
  input: repeatStateSchema,
  output: repeatStateSchema,
  goal: ({ value }) => `Repair ${value}.`,
});

const evaluatorTask = defineAgentTask({
  id: "validation.fixture.evaluator",
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
    body: ({ input, task }) =>
      task(repairTask, { input, workspace: "shared" }).output,
    until: validatedBy(evaluatorTask),
    maximumIterations: 3,
  })
  .output(({ tasks }) => tasks.repair.output)
  .define();
