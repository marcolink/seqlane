import type {
  InvocationId,
  LocalTaskDefinition,
  TaskId,
  TaskContext,
} from "@seqlane/core";
import {
  MastraProcessCancelledError,
  runMastraProcess,
} from "./mastra-process.js";

export const DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface LocalTaskExecutionRequest {
  readonly definition: LocalTaskDefinition<unknown, unknown>;
  readonly input: unknown;
  readonly cwd: string;
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly signal: AbortSignal;
  readonly outputLimitBytes?: number;
}

function taskContext(
  cwd: string,
  taskId: TaskId,
  invocationId: InvocationId,
  signal: AbortSignal,
  outputLimitBytes: number,
): TaskContext {
  return {
    exec: async (request) =>
      runMastraProcess({
        command: request.command,
        args: request.args ?? [],
        cwd,
        taskId,
        invocationId,
        outputLimitBytes,
        signal,
        timeoutMs: request.timeoutMs,
      }),
  };
}

export async function executeLocalTask(
  request: LocalTaskExecutionRequest,
): Promise<unknown> {
  const context = taskContext(
    request.cwd,
    request.taskId,
    request.invocationId,
    request.signal,
    request.outputLimitBytes ?? DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES,
  );
  const output = await request.definition.execute(request.input, context);
  if (request.signal.aborted) {
    throw new MastraProcessCancelledError(request.signal.reason);
  }
  return output;
}
