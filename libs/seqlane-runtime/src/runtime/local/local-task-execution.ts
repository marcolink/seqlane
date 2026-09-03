import type {
  LocalTaskDefinition,
  TaskContext,
  TaskExecResult,
} from "@seqlane/core";
import {
  EffectSubprocessInterruptedError,
  runEffectSubprocess,
} from "./effect-subprocess.js";

export const DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface LocalTaskExecutionRequest {
  readonly definition: LocalTaskDefinition<unknown, unknown>;
  readonly input: unknown;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly outputLimitBytes?: number;
}

function taskContext(
  cwd: string,
  signal: AbortSignal,
  outputLimitBytes: number,
): TaskContext {
  return {
    exec: async (request): Promise<TaskExecResult> =>
      runEffectSubprocess({
        command: request.command,
        args: request.args ?? [],
        cwd,
        outputLimitBytes,
        signal,
      }),
  };
}

export async function executeLocalTask(
  request: LocalTaskExecutionRequest,
): Promise<unknown> {
  const context = taskContext(
    request.cwd,
    request.signal,
    request.outputLimitBytes ?? DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES,
  );
  const output = await request.definition.execute(request.input, context);
  if (request.signal.aborted) {
    throw new EffectSubprocessInterruptedError(request.signal.reason);
  }
  return output;
}
