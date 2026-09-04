import type {
  JsonValue,
  TaskSchemaRegistry,
  WorkflowDefinition,
} from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import { createMastraAcpExecutor } from "./mastra-acp-executor.js";
import { createOpenCodeRun, type OpenCodeConnection } from "./session.js";

export interface OpenCodeRunnerExecution {
  readonly executors: ReadonlyMap<
    string,
    ReturnType<typeof createMastraAcpExecutor>
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
    const executor = createMastraAcpExecutor(built.taskDefinitions, {
      workspace: run.workspace,
    });

    return {
      executors: new Map([["opencode", executor]]),
      taskSchemas: built.taskDefinitions,
    };
  };
}
