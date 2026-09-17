import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({ value: z.string() });

const localTask = defineTask({
  id: "local-only-example-task",
  input: inputSchema,
  output: outputSchema,
  execute: async ({ input: { value } }) => ({ value }),
});

export default createFlow({
  id: "local-only-example",
  input: inputSchema,
  output: outputSchema,
})
  .task("local", localTask, ({ input }) => input)
  .output(({ tasks }) => tasks.local.output)
  .define();
