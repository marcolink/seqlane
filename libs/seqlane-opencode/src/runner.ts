import type {
  JsonValue,
  TaskSchemaRegistry,
  WorkflowDefinition,
} from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import { createOpenCodeExecutor } from "./executor.js";
import { createOpenCodeRun, type OpenCodeConnection } from "./session.js";

export interface OpenCodeRunnerExecution {
  readonly executors: ReadonlyMap<
    string,
    ReturnType<typeof createOpenCodeExecutor>
  >;
  readonly taskSchemas: TaskSchemaRegistry;
}

export type OpenCodeRunnerExecutionFactory = (
  input: JsonValue,
  connection: OpenCodeConnection,
  signal?: AbortSignal,
) => Promise<OpenCodeRunnerExecution>;

/** Captures authored definitions and creates all OpenCode state inside the child runner. */
export function createOpenCodeRunnerExecution<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
): OpenCodeRunnerExecutionFactory {
  return async (_input, connection, signal) => {
    const built = buildWorkflow(workflow);
    const run = await createOpenCodeRun(connection, signal);
    const executor = createOpenCodeExecutor(built.taskDefinitions, run);

    return {
      executors: new Map([["opencode", executor]]),
      taskSchemas: built.taskDefinitions,
    };
  };
}
