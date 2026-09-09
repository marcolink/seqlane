import type {
  InvocationId,
  TaskDefinition,
  TaskId,
  TaskContext,
} from "@seqlane/core";
import {
  MastraProcessCancelledError,
  runMastraProcess,
} from "./mastra-process.js";

export const DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface LocalTaskExecutionRequest {
  readonly definition: TaskDefinition<unknown, unknown>;
  readonly input: unknown;
  readonly cwd: string;
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly signal: AbortSignal;
  readonly outputLimitBytes?: number;
  readonly runAgent: TaskContext["runAgent"];
}

function taskContext(
  cwd: string,
  taskId: TaskId,
  invocationId: InvocationId,
  signal: AbortSignal,
  outputLimitBytes: number,
  runAgent: TaskContext["runAgent"],
): TaskContext {
  return {
    exec: async (request) =>
      runMastraProcess({
        command: request.executable,
        args: request.argv ?? [],
        cwd,
        taskId,
        invocationId,
        outputLimitBytes,
        signal,
        timeoutMs: request.timeoutMs,
      }),
    runAgent,
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
    request.runAgent,
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
