import type { AgentTaskDefinition } from "./task.js";

const responseFormatInstruction =
  "Response format: Return only the requested structured output.";

/** Builds the user-facing request from private task metadata. */
export function buildOpenCodePrompt(
  task: AgentTaskDefinition,
  input: unknown,
): string {
  const objective = task.goal(input);
  if (typeof objective !== "string" || objective.trim().length === 0) {
    throw new Error(`OpenCode task "${task.id}" returned an empty objective`);
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
