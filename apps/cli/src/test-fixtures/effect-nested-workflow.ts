import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const pathSchema = z.string().min(1);
const childInputSchema = z
  .object({
    traceDir: pathSchema,
    value: z.string(),
    defaults: z
      .object({
        enabled: z.boolean().default(false),
        count: z.number().int().default(0),
        label: z.string().default(""),
      })
      .prefault({}),
  })
  .transform((input) => {
    appendFileSync(join(input.traceDir, "child-input-parsed"), "parsed\n");
    return {
      ...input,
      value: `normalized:${input.value}`,
    };
  });

const normalizedChildInputSchema = z.object({
  traceDir: pathSchema,
  value: z.string(),
  defaults: z.object({
    enabled: z.boolean(),
    count: z.number().int(),
    label: z.string(),
  }),
});

const nestedOutputSchema = z.object({
  value: z.string(),
  defaults: z.object({
    enabled: z.boolean(),
    count: z.number().int(),
    label: z.string(),
  }),
});

const deterministicTask = defineTask({
  id: "effect-nested-deterministic",
  input: normalizedChildInputSchema,
  output: nestedOutputSchema,
  execute: async ({ input }) => ({
    value: input.value,
    defaults: input.defaults,
  }),
});

const childWorkflow = createFlow({
  id: "effect-v4-nested-child-fixture",
  input: childInputSchema,
  output: nestedOutputSchema,
})
  .task("deterministic", deterministicTask, ({ input }) => input)
  .output(({ tasks }) => tasks.deterministic.output)
  .define();

const parentInputSchema = z
  .object({
    traceDir: pathSchema,
    value: z.string().default("child"),
  })
  .transform((input) => {
    appendFileSync(join(input.traceDir, "parent-input-parsed"), "parsed\n");
    return input;
  });

export const effectNestedWorkflow = createFlow({
  id: "effect-v4-nested-parent-fixture",
  input: parentInputSchema,
  output: nestedOutputSchema,
})
  .task("child", childWorkflow, ({ input }) => ({
    traceDir: input.traceDir,
    value: input.value,
    defaults: { enabled: false, count: 0, label: "" },
  }))
  .output(({ tasks }) => tasks.child.output)
  .define();
