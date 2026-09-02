import type {
  TaskDefinitionRegistry,
  SeqlaneSchema,
  TaskId,
} from "@seqlane/core";

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

const unknownSchema: SeqlaneSchema = {
  parse(value: unknown): unknown {
    return value;
  },
};

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
