import type { TaskDefinition, TaskDefinitionRegistry } from "@seqlane/core";

export type JsonSchema = { readonly [key: string]: unknown };

export function getOpenCodeTask(
  tasks: TaskDefinitionRegistry,
  taskId: string,
): TaskDefinition {
  const task = tasks.get(taskId);
  if (!task) {
    throw new Error(`No task definition found for "${taskId}"`);
  }
  return task;
}
