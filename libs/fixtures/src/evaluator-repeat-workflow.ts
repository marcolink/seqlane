import { createFlow, defineAgentTask } from "@seqlane/core";
import { z } from "zod";

const repeatInputSchema = z.object({ seed: z.string() });
const repeatStateSchema = z.object({
  value: z.string(),
  attempt: z.number(),
  ready: z.boolean(),
});

const repairTask = defineAgentTask({
  id: "validation.fixture.repair",
  input: repeatStateSchema,
  output: repeatStateSchema,
  goal: ({ value }) => `Repair ${value}.`,
});

export const evaluatorRepeatWorkflow = createFlow({
  id: "validation-fixture-evaluator-repeat",
  input: repeatInputSchema,
  output: repeatStateSchema,
})
  .task(
    "repair",
    repairTask,
    ({ input }) => ({ value: input.seed, attempt: 0, ready: false }),
    { workspace: "shared" },
  )
  .until(({ result }) => result.ready, {
    maxIterations: 3,
    nextInput: ({ result }) => ({
      value: result.value,
      attempt: result.attempt,
      ready: false,
    }),
  })
  .output(({ tasks }) => tasks.repair.output)
  .define();
