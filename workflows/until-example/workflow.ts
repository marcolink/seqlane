import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const inputSchema = z.object({
  remaining: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
});
const outputSchema = z.object({
  remaining: z.number().int().nonnegative(),
  attempts: z.number().int(),
  done: z.boolean(),
});

const attemptTask = defineTask({
  id: "until-example-attempt",
  input: inputSchema,
  output: outputSchema,
  execute: async ({ input }) => ({
    remaining: input.remaining - 1,
    attempts: input.attempts + 1,
    done: input.remaining === 1,
  }),
});

export default createFlow({
  id: "until-example",
  input: inputSchema,
  output: outputSchema,
})
  .task("attempt", attemptTask, ({ input }) => input)
  .until(({ result }) => result.done, {
    maxIterations: 10,
    nextInput: ({ result }) => result,
  })
  .output(({ tasks }) => tasks.attempt.output)
  .define();
