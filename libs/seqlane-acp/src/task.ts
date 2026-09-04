import type {
  AgentTaskDefinition,
  TaskDefinition,
  TaskDefinitionRegistry,
} from "@seqlane/core";
import { z } from "zod";

export type JsonSchema = { readonly [key: string]: unknown };

function isAgentTaskDefinition(
  value: TaskDefinition,
): value is AgentTaskDefinition {
  return typeof value.goal === "function";
}

export function getAgentTask(
  tasks: TaskDefinitionRegistry,
  taskId: string,
): AgentTaskDefinition {
  const task = tasks.get(taskId);
  if (task === undefined || !isAgentTaskDefinition(task)) {
    throw new Error(`No agent task definition found for "${taskId}"`);
  }
  return task;
}

export function toJsonSchema(task: AgentTaskDefinition): JsonSchema {
  if (!(task.output instanceof z.ZodType)) {
    throw new Error(
      `Agent task "${task.id}" output schema cannot produce JSON Schema`,
    );
  }

  try {
    return z.toJSONSchema(task.output);
  } catch (cause) {
    throw new Error(
      `Agent task "${task.id}" output schema cannot produce JSON Schema`,
      { cause },
    );
  }
}
