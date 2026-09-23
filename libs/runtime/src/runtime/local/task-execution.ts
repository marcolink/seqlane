import type {
  InvocationId,
  TaskDefinition,
  TaskId,
  TaskContext,
} from "@seqlane/core";
import {
  MastraProcessCancelledError,
  MastraProcessTerminationError,
  runMastraProcess,
} from "./mastra-process.js";
import type { SeqlaneUncertainActivity } from "../execution/executor.js";

export const DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export {
  DEFAULT_MASTRA_PROCESS_TIMEOUT_MS as DEFAULT_LOCAL_TASK_TIMEOUT_MS,
  MAX_MASTRA_PROCESS_TIMEOUT_MS as MAX_LOCAL_TASK_TIMEOUT_MS,
} from "./mastra-process.js";

export interface TaskExecutionRequest {
  readonly definition: TaskDefinition<unknown, unknown>;
  readonly input: unknown;
  readonly cwd: string;
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly signal: AbortSignal;
  readonly outputLimitBytes?: number;
  readonly runAgent: TaskContext["runAgent"];
  readonly classify?: NonNullable<TaskContext["classify"]>;
  readonly onUncertainActivity?: (activity: SeqlaneUncertainActivity) => void;
}

function taskContext(
  cwd: string,
  taskId: TaskId,
  invocationId: InvocationId,
  signal: AbortSignal,
  outputLimitBytes: number,
  runAgent: TaskContext["runAgent"],
  classify: NonNullable<TaskContext["classify"]> | undefined,
  onUncertainActivity: TaskExecutionRequest["onUncertainActivity"],
): TaskContext {
  const baseContext: TaskContext = {
    exec: async (request) => {
      try {
        return await runMastraProcess({
          command: request.executable,
          args: request.argv ?? [],
          cwd,
          taskId,
          invocationId,
          outputLimitBytes,
          signal,
          timeoutMs: request.timeoutMs,
        });
      } catch (cause) {
        if (cause instanceof MastraProcessTerminationError) {
          onUncertainActivity?.({ reason: "timeout" });
        }
        throw cause;
      }
    },
    runAgent,
  };
  return classify === undefined ? baseContext : { ...baseContext, classify };
}

export async function executeTask(
  request: TaskExecutionRequest,
): Promise<unknown> {
  const context = taskContext(
    request.cwd,
    request.taskId,
    request.invocationId,
    request.signal,
    request.outputLimitBytes ?? DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES,
    request.runAgent,
    request.classify,
    request.onUncertainActivity,
  );
  const output = await request.definition.execute({
    input: request.input,
    signal: request.signal,
    context,
  });
  if (request.signal.aborted) {
    throw new MastraProcessCancelledError(request.signal.reason);
  }
  return output;
}
