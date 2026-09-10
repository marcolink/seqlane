import type {
  TaskDefinitionRegistry,
  SeqlaneSchema,
  TaskId,
} from "@seqlane/core";
import { z } from "zod";

export {
  ExecutorError,
  InputValidationError,
  OutputValidationError,
  RuntimeError,
} from "@seqlane/core";

export interface TaskSchema<Input = unknown, Output = unknown> {
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
}

export type TaskSchemaRegistry = ReadonlyMap<TaskId, TaskSchema>;

const unknownSchema: SeqlaneSchema = z.unknown();

export function getTaskSchema(
  schemas: TaskSchemaRegistry | undefined,
  taskId: TaskId,
  taskDefinitions?: TaskDefinitionRegistry,
): TaskSchema {
  return (
    schemas?.get(taskId) ?? {
      input: taskDefinitions?.get(taskId)?.input ?? unknownSchema,
      output: taskDefinitions?.get(taskId)?.output ?? unknownSchema,
    }
  );
}
