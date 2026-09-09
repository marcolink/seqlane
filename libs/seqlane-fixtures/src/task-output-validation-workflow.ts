import { createFlow, defineAgentTask, defineValidator } from "@seqlane/core";
import { z } from "zod";

const taskOutputInputSchema = z.object({
  candidate: z.string(),
  shouldPass: z.boolean(),
});

const candidateOutputSchema = z.object({
  candidate: z.string(),
  accepted: z.boolean(),
});

const taskOutputValidator = defineValidator({
  id: "validation.fixture.mechanical",
  input: candidateOutputSchema,
  validate: ({ accepted }) =>
    accepted
      ? { success: true, evidence: { policy: "accepted" } }
      : {
          success: false,
          issues: [
            {
              code: "candidate-rejected",
              message: "The fixture candidate was rejected",
            },
          ],
          evidence: { policy: "rejected" },
        },
});

const produceTask = defineAgentTask({
  id: "validation.fixture.produce",
  input: taskOutputInputSchema,
  output: candidateOutputSchema,
  goal: ({ candidate }) => `Produce a candidate for ${candidate}.`,
});

const dependentTask = defineAgentTask({
  id: "validation.fixture.dependent",
  input: z.object({ candidate: z.string() }),
  output: z.object({ candidate: z.string(), completed: z.literal(true) }),
  goal: ({ candidate }) => `Complete work for ${candidate}.`,
});

export const taskOutputValidationWorkflow = createFlow({
  id: "validation-fixture-task-output",
  input: taskOutputInputSchema,
  output: z.object({ candidate: z.string(), completed: z.literal(true) }),
})
  .task("candidate", produceTask, ({ input }) => input, {
    workspace: "shared",
    validateOutput: taskOutputValidator,
  })
  .task(
    "dependent",
    dependentTask,
    ({ tasks }) => ({
      candidate: tasks.candidate.output.candidate,
    }),
    { workspace: "shared" },
  )
  .output(({ tasks }) => tasks.dependent.output)
  .define();
