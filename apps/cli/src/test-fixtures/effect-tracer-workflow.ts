import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

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
