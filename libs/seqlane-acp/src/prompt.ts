import type { AgentTaskDefinition } from "@seqlane/core";
import type { JsonSchema } from "./task.js";

const responseFormatInstruction =
  "Response format: Return only the requested structured output.";

export function buildAgentPrompt(
  task: AgentTaskDefinition,
  input: unknown,
): string {
  const objective = task.goal(input);
  if (typeof objective !== "string" || objective.trim().length === 0) {
    throw new Error(`Agent task "${task.id}" returned an empty objective`);
  }

  return [
    objective,
    responseFormatInstruction,
    ...(task.instructions ?? []).map(
      (instruction) => `Task instruction: ${instruction}`,
    ),
    ...(task.references ?? []).map(
      (reference) => `Task reference: ${reference}`,
    ),
  ].join("\n");
}

export function buildStructuredOutputPrompt(
  taskPrompt: string,
  schema: JsonSchema,
): string {
  return [
    taskPrompt,
    "--- Seqlane structured output contract ---",
    "Perform the task normally. Your final response must contain exactly one JSON value matching this JSON Schema.",
    "Return JSON only. Do not use Markdown, commentary, or any additional text.",
    JSON.stringify(schema),
    "--- End Seqlane structured output contract ---",
  ].join("\n");
}

export function buildStructuredOutputRepairPrompt(issues: string): string {
  return [
    "--- Seqlane structured output repair ---",
    "Return only a corrected JSON value for the already completed task.",
    "Do not repeat the task, use tools, or include Markdown or commentary.",
    `Validation errors: ${issues}`,
    "--- End Seqlane structured output repair ---",
  ].join("\n");
}
