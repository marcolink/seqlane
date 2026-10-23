import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const pathSchema = z.string().min(1);
const nestedSchema = z
  .object({
    enabled: z.boolean().default(false),
    count: z.number().int().default(0),
    empty: z.string().default(""),
  })
  .default({ enabled: false, count: 0, empty: "" });
const payloadSchema = z.object({
  token: z.string().transform((value) => ({ value: `normalized:${value}` })),
  nested: nestedSchema,
});
const workflowInputSchema = z.object({
  traceDir: pathSchema,
  payload: payloadSchema,
});
const normalizedPayloadSchema = z.object({
  token: z.object({ value: z.string() }),
  nested: z.object({
    enabled: z.boolean(),
    count: z.number().int(),
    empty: z.string(),
  }),
});
const unitOutputSchema = z.object({ done: z.literal(true) });
const slowOutputSchema = z.object({ slow: z.literal("settled") });
const workflowOutputSchema = z.object({
  payload: normalizedPayloadSchema,
  slow: z.literal("settled"),
});

const fastTask = defineTask({
  id: "effect-dag-fast",
  input: z.object({ traceDir: pathSchema, payload: normalizedPayloadSchema }),
  output: normalizedPayloadSchema,
  execute: async ({ input }) => {
    await writeFile(join(input.traceDir, "fast.started"), "started");
    return input.payload;
  },
});

const slowTask = defineTask({
  id: "effect-dag-slow",
  input: z.object({ traceDir: pathSchema }),
  output: slowOutputSchema,
  execute: async ({ input }) => {
    await writeFile(join(input.traceDir, "slow.started"), "started");
    const releasePath = join(input.traceDir, "slow.release");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        await access(releasePath);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      await writeFile(join(input.traceDir, "slow.settled"), "settled");
      return { slow: "settled" };
    }
    throw new Error("Timed out waiting for the graph test release marker");
  },
});

const successorTask = defineTask({
  id: "effect-dag-fast-successor",
  input: z.object({
    traceDir: pathSchema,
    payload: normalizedPayloadSchema,
  }),
  output: normalizedPayloadSchema,
  execute: async ({ input }) => {
    await writeFile(join(input.traceDir, "successor.started"), "started");
    return input.payload;
  },
});

const joinTask = defineTask({
  id: "effect-dag-join",
  input: z.object({
    traceDir: pathSchema,
    payload: normalizedPayloadSchema,
    slow: z.literal("settled"),
  }),
  output: workflowOutputSchema,
  execute: async ({ input }) => {
    await writeFile(join(input.traceDir, "join.started"), "started");
    return { payload: input.payload, slow: input.slow };
  },
});

export const effectDagWorkflow = createFlow({
  id: "effect-v4-dependency-graph-fixture",
  input: workflowInputSchema,
  output: workflowOutputSchema,
})
  .task("fast", fastTask, ({ input }) => input, { workspace: "shared" })
  .task("slow", slowTask, ({ input }) => ({ traceDir: input.traceDir }), {
    workspace: "shared",
  })
  .task(
    "successor",
    successorTask,
    ({ input, tasks }) => ({
      traceDir: input.traceDir,
      payload: tasks.fast.output,
    }),
    { workspace: "shared" },
  )
  .task(
    "join",
    joinTask,
    ({ input, tasks }) => ({
      traceDir: input.traceDir,
      payload: tasks.successor.output,
      slow: tasks.slow.output.slow,
    }),
    { workspace: "shared" },
  )
  .output(({ tasks }) => tasks.join.output)
  .define();

const malformedSourceTask = defineTask({
  id: "effect-dag-malformed-source",
  input: z.object({ traceDir: pathSchema }),
  output: z.number(),
  execute: async () => 42,
});
const malformedTargetTask = defineTask({
  id: "effect-dag-malformed-target",
  input: z.unknown().pipe(z.string()),
  output: unitOutputSchema,
  execute: async ({ input }) => {
    await writeFile(input, "body-ran");
    return { done: true };
  },
});
const malformedWorkflowInputSchema = z.object({ traceDir: pathSchema });

export const effectDagMalformedWorkflow = createFlow({
  id: "effect-v4-dependency-graph-malformed-input-fixture",
  input: malformedWorkflowInputSchema,
  output: unitOutputSchema,
})
  .task(
    "source",
    malformedSourceTask,
    ({ input }) => ({ traceDir: input.traceDir }),
    { workspace: "shared" },
  )
  .task("target", malformedTargetTask, ({ tasks }) => tasks.source.output, {
    workspace: "shared",
  })
  .output(({ tasks }) => tasks.target.output)
  .define();

const failureInputSchema = z.object({ traceDir: pathSchema });
const failureSchema = z.object({ failed: z.literal(true) });
const independentSchema = z.object({ settled: z.literal(true) });
const failedTask = defineTask({
  id: "effect-dag-failing-dependency",
  input: z.object({ traceDir: pathSchema }),
  output: failureSchema,
  execute: async ({ input }) => {
    await writeFile(join(input.traceDir, "failure.started"), "started");
    throw new Error("fixture dependency failure");
  },
});
const skippedTask = defineTask({
  id: "effect-dag-skipped-dependent",
  input: z.object({ traceDir: pathSchema }),
  output: unitOutputSchema,
  execute: async ({ input }) => {
    await writeFile(join(input.traceDir, "dependent.started"), "started");
    return { done: true };
  },
});
const independentTask = defineTask({
  id: "effect-dag-independent-active-work",
  input: z.object({ traceDir: pathSchema }),
  output: independentSchema,
  execute: async ({ input }) => {
    await writeFile(join(input.traceDir, "independent.started"), "started");
    const releasePath = join(input.traceDir, "independent.release");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        await access(releasePath);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      await writeFile(join(input.traceDir, "independent.settled"), "settled");
      return { settled: true };
    }
    throw new Error("Timed out waiting for the failure test release marker");
  },
});
const failureOutputSchema = z.object({ settled: z.boolean() });

export const effectDagFailureWorkflow = createFlow({
  id: "effect-v4-dependency-graph-failure-fixture",
  input: failureInputSchema,
  output: failureOutputSchema,
})
  .task("failure", failedTask, ({ input }) => input, { workspace: "shared" })
  .task("dependent", skippedTask, ({ input }) => input, {
    dependsOn: ["failure"],
    workspace: "shared",
  })
  .task("independent", independentTask, ({ input }) => input, {
    workspace: "shared",
  })
  .output(({ tasks }) => ({ settled: tasks.independent.output.settled }))
  .define();
