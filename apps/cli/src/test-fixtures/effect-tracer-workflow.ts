import { createFlow, defineClassifierTask, defineTask } from "@seqlane/core";
import { z } from "zod";

if (
  process.env.SEQLANE_CLASSIFIER_API_KEY ||
  process.env.SEQLANE_RUNNER_CLASSIFIER_URL ||
  process.env.SEQLANE_RUNNER_CLASSIFIER_MODEL
) {
  throw new Error("Classifier configuration leaked before workflow import");
}

const inputSchema = z.object({
  value: z.string(),
  mode: z
    .enum([
      "success",
      "failure",
      "hang",
      "malformed-task-output",
      "malformed-workflow-output",
    ])
    .default("success"),
  timeoutMs: z.number().int().positive().optional(),
  pidFile: z.string().optional(),
});
const outputSchema = z.object({ value: z.string() });
const taskInputSchema = inputSchema.extend({ value: z.string().min(1) });
const workflowOutputSchema = z.object({ value: z.string().min(1) });

const shellTask = defineTask({
  id: "effect-tracer-shell",
  input: taskInputSchema,
  output: outputSchema,
  execute: async ({ input, context, signal }) => {
    const source = [
      "const [value, mode, pidFile] = process.argv.slice(1);",
      'if (pidFile) require("node:fs").writeFileSync(pidFile, String(process.pid));',
      'if (mode === "hang") { setInterval(() => {}, 1000); }',
      'else if (mode === "failure") { process.stderr.write("fixture failure"); process.exitCode = 7; }',
      'else if (mode === "malformed-task-output") { process.stdout.write(JSON.stringify({ unexpected: true })); }',
      'else if (mode === "malformed-workflow-output") { process.stdout.write(JSON.stringify({ value: "" })); }',
      "else { process.stdout.write(JSON.stringify({ value: `effect:${value}` })); }",
    ].join(" ");
    const result = await context.exec({
      executable: process.execPath,
      argv: ["-e", source, input.value, input.mode, input.pidFile ?? ""],
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (signal.aborted) return { value: "cancelled" };
    if (result.exitCode !== 0) {
      throw new Error(`fixture process exited with ${result.exitCode}`);
    }
    if (input.mode === "malformed-task-output") {
      const malformed = { value: "fixture" };
      Reflect.deleteProperty(malformed, "value");
      return malformed;
    }
    const output: unknown = JSON.parse(result.stdout);
    return outputSchema.parse(output);
  },
});

export const effectTracerWorkflow = createFlow({
  id: "effect-tracer-worker-fixture",
  input: inputSchema,
  output: workflowOutputSchema,
})
  .task("shell", shellTask, ({ input }) => input)
  .output(({ tasks }) => tasks.shell.output)
  .define();

const classifierInputSchema = z.object({ diff: z.string() });
const preparedSchema = z.object({ diff: z.string() });
const prepared = defineTask({
  id: "effect-classifier.prepare",
  input: classifierInputSchema,
  output: preparedSchema,
  execute: async ({ input }) => ({ diff: `prepared:${input.diff}` }),
});
const classifier = defineClassifierTask({
  id: "effect-classifier.classify",
  input: preparedSchema,
  state: ({ diff }) => ({ diff }),
  questions: {
    area: {
      kind: "choice",
      instructions: "Which area changed?",
      criteria: { runtime: "Runtime", docs: "Documentation" },
    },
    priority: {
      kind: "score",
      instructions: "How urgent is review?",
      criteria: ["Low", "High"],
    },
    needsReview: { kind: "noul", instructions: "Does this diff need review?" },
  },
});
const consumedSchema = z.object({
  area: z.string(),
  priority: z.number(),
  reviewRequired: z.boolean(),
});
const consume = defineTask({
  id: "effect-classifier.consume",
  input: classifier.output,
  output: consumedSchema,
  execute: async ({ input }) => ({
    area:
      input.answers.area?.kind === "choice"
        ? input.answers.area.selected
        : "unknown",
    priority:
      input.answers.priority?.kind === "score"
        ? input.answers.priority.value
        : -1,
    reviewRequired:
      input.answers.needsReview?.kind === "noul" &&
      input.answers.needsReview.probability > 0.5,
  }),
});

export const effectClassifierWorkflow = createFlow({
  id: "effect-classifier-worker-fixture",
  input: classifierInputSchema,
  output: consumedSchema,
})
  .task("prepare", prepared, ({ input }) => input)
  .task("classify", classifier, ({ tasks }) => tasks.prepare.output)
  .task("consume", consume, ({ tasks }) => tasks.classify.output)
  .output(({ tasks }) => tasks.consume.output)
  .define();
