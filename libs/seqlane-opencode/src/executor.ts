import type {
  TaskDefinitionRegistry,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";
import { getOpenCodeTask } from "./task.js";
import { buildOpenCodePrompt } from "./task-prompt.js";
import { toOpenCodeJsonSchema } from "./task-schema.js";
import type { OpenCodeRun } from "./session.js";
import type {
  OpenCodeActivity,
  OpenCodeBackgroundProcess,
  OpenCodeUncertainActivity,
} from "./protocol.js";

export interface OpenCodeExecutorRequest {
  readonly invocationId: string;
  readonly taskId: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly onMetrics?: (metrics: SeqlaneInvocationMetrics) => void;
  readonly onActivity?: (activity: OpenCodeActivity) => void;
  readonly onUncertainActivity?: (activity: OpenCodeUncertainActivity) => void;
  readonly onBackgroundProcess?: (process: OpenCodeBackgroundProcess) => void;
}

export interface OpenCodeExecutor {
  execute(request: OpenCodeExecutorRequest): Promise<unknown>;
}

export function createOpenCodeExecutor(
  tasks: TaskDefinitionRegistry,
  run: OpenCodeRun,
): OpenCodeExecutor {
  return {
    async execute(request) {
      const task = getOpenCodeTask(tasks, request.taskId);
      const schema = toOpenCodeJsonSchema(task);

      const response = await run.prompt({
        text: buildOpenCodePrompt(task, request.input),
        schema,
        signal: request.signal,
        onActivity: request.onActivity,
        onUncertainActivity: request.onUncertainActivity,
        ...(request.onBackgroundProcess === undefined
          ? {}
          : { onBackgroundProcess: request.onBackgroundProcess }),
      });
      if (response.metrics !== undefined) request.onMetrics?.(response.metrics);
      return response.structured;
    },
  };
}
