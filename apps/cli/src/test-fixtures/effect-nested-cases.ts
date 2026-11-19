import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createFlow, defineTask, defineValidator } from "@seqlane/core";
import { z } from "zod";

const pathSchema = z.string().min(1);
const attemptInputSchema = z.object({
  traceDir: pathSchema,
  value: z.number().int().positive(),
  reject: z.boolean(),
});
const outputSchema = z.object({
  value: z.number().int(),
  accepted: z.boolean(),
  source: z.enum(["attempt", "unselected"]),
});
const attemptOutputSchema = z.object({
  value: z.number().int(),
  accepted: z.boolean(),
  source: z.literal("attempt"),
  done: z.boolean(),
  nextValue: z.number().int(),
});
const repeatedChildOutputSchema = z.object({
  value: z.number().int(),
  accepted: z.boolean(),
  source: z.literal("attempt"),
});
const unselectedOutputSchema = z.object({
  value: z.number().int(),
  accepted: z.boolean(),
  source: z.literal("unselected"),
});

const acceptedOutputValidator = defineValidator({
  id: "effect-nested-output-accepted",
  input: attemptOutputSchema,
  validate: ({ accepted }) =>
    accepted
      ? { success: true, evidence: { accepted } }
      : {
          success: false,
          issues: [
            {
              code: "rejected-output",
              message: "The nested attempt output was rejected",
            },
          ],
        },
});

const attemptTask = defineTask({
  id: "effect-nested-repeat-attempt",
  input: attemptInputSchema,
  output: attemptOutputSchema,
  execute: async ({ input }) => {
    appendFileSync(join(input.traceDir, "repeat-attempts"), `${input.value}\n`);
    return {
      value: input.value + 1,
      accepted: !input.reject,
      source: "attempt",
      done: input.value + 1 >= 4,
      nextValue: input.value + 2,
    };
  },
});

const repeatedChildWorkflow = createFlow({
  id: "effect-v4-nested-repeat-child-fixture",
  input: attemptInputSchema,
  output: repeatedChildOutputSchema,
})
  .task("attempt", attemptTask, ({ input }) => input, {
    validateOutput: acceptedOutputValidator,
  })
  .until(({ result }) => result.done, {
    maxIterations: 3,
    nextInput: ({ input, result }) => ({
      traceDir: input.traceDir,
      value: result.nextValue,
      reject: input.reject,
    }),
  })
  .output(({ tasks }) => ({
    value: tasks.attempt.output.value,
    accepted: tasks.attempt.output.accepted,
    source: tasks.attempt.output.source,
  }))
  .define();

const choiceInputSchema = z.object({
  traceDir: pathSchema,
  selected: z.boolean(),
  value: z
    .enum(["valid", "invalid"])
    .transform((value) => (value === "valid" ? 1 : -1)),
  reject: z.boolean(),
});

const unselectedTask = defineTask({
  id: "effect-nested-unselected-arm",
  input: z.object({
    traceDir: pathSchema,
    value: z.number().int(),
    reject: z.boolean(),
  }),
  output: unselectedOutputSchema,
  execute: async ({ input }) => {
    appendFileSync(join(input.traceDir, "unselected-started"), "started\n");
    return {
      value: input.value,
      accepted: true,
      source: "unselected",
    };
  },
});

export const effectNestedChoiceRepeatWorkflow = createFlow({
  id: "effect-v4-nested-choice-repeat-parent-fixture",
  input: choiceInputSchema,
  output: outputSchema,
})
  .when(({ input }) => input.selected)
  .task("selected", repeatedChildWorkflow, ({ input }) => ({
    traceDir: input.traceDir,
    value: input.value,
    reject: input.reject,
  }))
  .otherwise(unselectedTask, ({ input }) => ({
    traceDir: input.traceDir,
    value: input.value,
    reject: input.reject,
  }))
  .output(({ tasks }) => tasks.selected.output)
  .define();

const cancelInputSchema = z.object({
  traceDir: pathSchema,
  value: z.number().int().positive(),
});
const cancelTaskOutputSchema = z.object({
  value: z.number().int(),
  done: z.boolean(),
  nextValue: z.number().int(),
});
const cancelOutputSchema = z.object({ value: z.number().int() });

const cancelTask = defineTask({
  id: "effect-nested-cancel-task",
  input: cancelInputSchema,
  output: cancelTaskOutputSchema,
  execute: async ({ input, signal }) => {
    appendFileSync(join(input.traceDir, "cancel-started"), "started\n");
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      return {
        value: input.value,
        done: input.value > 2,
        nextValue: input.value + 1,
      };
    } finally {
      appendFileSync(
        join(input.traceDir, "cancel-cleanup-started"),
        "started\n",
      );
      const releasePath = join(input.traceDir, "cancel-cleanup-release");
      const deadline = Date.now() + 15_000;
      while (!existsSync(releasePath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      appendFileSync(join(input.traceDir, "cancel-cleaned"), "cleaned\n");
    }
  },
});

const cancelChildWorkflow = createFlow({
  id: "effect-v4-nested-cancel-child-fixture",
  input: cancelInputSchema,
  output: cancelOutputSchema,
})
  .task("cancel", cancelTask, ({ input }) => input)
  .until(({ result }) => result.done, {
    maxIterations: 2,
    nextInput: ({ input, result }) => ({
      traceDir: input.traceDir,
      value: result.nextValue,
    }),
  })
  .output(({ tasks }) => ({ value: tasks.cancel.output.value }))
  .define();

export const effectNestedCancellationWorkflow = createFlow({
  id: "effect-v4-nested-cancel-parent-fixture",
  input: cancelInputSchema,
  output: cancelOutputSchema,
})
  .task("child", cancelChildWorkflow, ({ input }) => input)
  .output(({ tasks }) => tasks.child.output)
  .define();
