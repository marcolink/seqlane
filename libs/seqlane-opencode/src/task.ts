import type { TaskDefinition, TaskDefinitionRegistry } from "@seqlane/core";

export type JsonSchema = { readonly [key: string]: unknown };

export type AgentTaskDefinition<
  Input = unknown,
  Output = unknown,
> = TaskDefinition<Input, Output>;

export function isAgentTaskDefinition(
  value: TaskDefinition,
): value is AgentTaskDefinition {
  return typeof value.goal === "function";
}

export function getOpenCodeTask(
  tasks: TaskDefinitionRegistry,
  taskId: string,
): AgentTaskDefinition {
  const task = tasks.get(taskId);
  if (!task || !isAgentTaskDefinition(task)) {
    throw new Error(`No agent task definition found for "${taskId}"`);
  }
  return task;
}
