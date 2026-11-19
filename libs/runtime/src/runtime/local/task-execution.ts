import type {
  InvocationId,
  TaskDefinition,
  TaskId,
  TaskContext,
} from "@seqlane/core";
import type { Context } from "effect";
import {
  LocalProcessCancelledError,
  LocalProcessTerminationError,
  runLocalProcess,
} from "./effect-process.js";
import type { SeqlaneUncertainActivity } from "../execution/executor.js";

export const DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export {
  DEFAULT_LOCAL_PROCESS_TIMEOUT_MS as DEFAULT_LOCAL_TASK_TIMEOUT_MS,
  MAX_LOCAL_PROCESS_TIMEOUT_MS as MAX_LOCAL_TASK_TIMEOUT_MS,
} from "./effect-process.js";

export interface TaskExecutionRequest {
  readonly nativeContext?: Context.Context<never>;
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
  readonly onOwnedProcessAcquired?: (pid: number) => Promise<void>;
}

function taskContext(request: TaskExecutionRequest): TaskContext {
  const {
    cwd,
    taskId,
    invocationId,
    signal,
    runAgent,
    classify,
    onUncertainActivity,
    onOwnedProcessAcquired,
  } = request;
  const baseContext: TaskContext = {
    exec: async (command) => {
      try {
        return await runLocalProcess(
          {
            command: command.executable,
            args: command.argv ?? [],
            cwd,
            taskId,
            invocationId,
            outputLimitBytes:
              request.outputLimitBytes ?? DEFAULT_LOCAL_TASK_OUTPUT_LIMIT_BYTES,
            signal,
            timeoutMs: command.timeoutMs,
            onOwnedProcessAcquired,
          },
          request.nativeContext,
        );
      } catch (cause) {
        if (cause instanceof LocalProcessTerminationError) {
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
  const context = taskContext(request);
  const output = await request.definition.execute({
    input: request.input,
    signal: request.signal,
    context,
  });
  if (request.signal.aborted) {
    throw new LocalProcessCancelledError(request.signal.reason);
  }
  return output;
}
