import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const valuesSchema = z.object({ values: z.array(z.number()) });
const totalSchema = z.object({ total: z.number() });
const summarySchema = z.object({
  total: z.number(),
  summary: z.string(),
});

const calculateTotalTask = defineTask({
  id: "nested-example.calculate-total",
  input: valuesSchema,
  output: totalSchema,
  execute: async ({ input }) => ({
    total: input.values.reduce((total, value) => total + value, 0),
  }),
});

const summarizeTotalTask = defineTask({
  id: "nested-example.summarize-total",
  input: totalSchema,
  output: summarySchema,
  execute: async ({ input }) => ({
    total: input.total,
    summary: `Total: ${input.total}`,
  }),
});

export const calculateTotalWorkflow = createFlow({
  id: "nested-example.calculate",
  input: valuesSchema,
  output: totalSchema,
})
  .task("calculate", calculateTotalTask, ({ input }) => input)
  .output(({ tasks }) => tasks.calculate.output)
  .define();

export default createFlow({
  id: "nested-example",
  input: valuesSchema,
  output: summarySchema,
})
  .task("calculate", calculateTotalWorkflow, ({ input }) => input)
  .task("summarize", summarizeTotalTask, ({ tasks }) => tasks.calculate.output)
  .output(({ tasks }) => tasks.summarize.output)
  .define();
