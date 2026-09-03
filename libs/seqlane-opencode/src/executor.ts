import type {
  TaskDefinitionRegistry,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";
import { getOpenCodeTask } from "./task.js";
import { buildOpenCodePrompt } from "./task-prompt.js";
import {
  buildStructuredOutputPrompt,
  buildStructuredOutputRepairPrompt,
} from "./task-prompt.js";
import { toOpenCodeJsonSchema } from "./task-schema.js";
import {
  parsePromptJson,
  summarizeStructuredOutputIssues,
  validatePromptJson,
} from "./structured-output-parser.js";
import { StructuredOutputValidationError } from "./errors.js";
import type { OpenCodeRun } from "./session.js";
import type { ResolvedStructuredOutput } from "./structured-output-strategy.js";
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
  readonly onDiagnostic?: (message: string) => void;
  readonly onActivity?: (activity: OpenCodeActivity) => void;
  readonly onUncertainActivity?: (activity: OpenCodeUncertainActivity) => void;
  readonly onBackgroundProcess?: (process: OpenCodeBackgroundProcess) => void;
}

function promptStrategyDiagnostic(
  selection: ResolvedStructuredOutput,
): string | undefined {
  if (selection.strategy !== "prompt" || selection.reason === "explicit") {
    return undefined;
  }
  const version =
    selection.version === undefined ? "" : ` for OpenCode ${selection.version}`;
  const reason =
    selection.reason === "affected-version"
      ? "the native implementation is on the compatibility list"
      : selection.reason === "unknown-version"
        ? "the OpenCode version is not verified"
        : selection.reason === "runtime-downgrade"
          ? "native output readback was not compatible"
          : "the runtime selected the compatibility fallback";
  return (
    `OpenCode structured output fallback is active${version}: using prompt mode because ${reason}. ` +
    "The JSON response is validated and repaired before task completion."
  );
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
      const selection = await run.structuredOutput?.();
      const strategy = selection?.strategy ?? "native";
      const retryCount = selection?.retryCount ?? 0;
      const diagnostic =
        selection === undefined
          ? undefined
          : promptStrategyDiagnostic(selection);
      if (diagnostic !== undefined) request.onDiagnostic?.(diagnostic);
      const basePrompt = buildOpenCodePrompt(task, request.input);
      let promptText =
        strategy === "prompt"
          ? buildStructuredOutputPrompt(basePrompt, schema)
          : basePrompt;
      let attempts = 0;
      let lastIssues: StructuredOutputValidationError | undefined;

      while (true) {
        attempts += 1;
        selection?.report?.({ type: "attempt", attempt: attempts });
        const response = await run.prompt({
          text: promptText,
          schema,
          strategy,
          retryCount,
          ...(lastIssues === undefined
            ? {}
            : { tools: { "*": false, StructuredOutput: true } }),
          signal: request.signal,
          onActivity: request.onActivity,
          onUncertainActivity: request.onUncertainActivity,
          ...(request.onBackgroundProcess === undefined
            ? {}
            : { onBackgroundProcess: request.onBackgroundProcess }),
        });
        if (response.metrics !== undefined)
          request.onMetrics?.(response.metrics);
        if (strategy === "native") {
          selection?.report?.({
            type: "completed",
            attempt: attempts,
            success: true,
          });
          return response.structured;
        }

        try {
          const parsed = parsePromptJson(response.text ?? "");
          const output = validatePromptJson(parsed, task.output);
          selection?.report?.({
            type: "completed",
            attempt: attempts,
            success: true,
          });
          return output;
        } catch (cause) {
          const validationError =
            cause instanceof StructuredOutputValidationError
              ? cause
              : new StructuredOutputValidationError(
                  1,
                  [
                    {
                      kind: "validation",
                      code: "schema_validation_failed",
                      message: "Output did not satisfy the task schema",
                    },
                  ],
                  cause,
                );
          lastIssues = validationError;
          if (attempts > retryCount) {
            selection?.report?.({
              type: "completed",
              attempt: attempts,
              success: false,
            });
            throw new StructuredOutputValidationError(
              attempts,
              validationError.issues,
              validationError,
            );
          }
          promptText = buildStructuredOutputRepairPrompt(
            summarizeStructuredOutputIssues(validationError.issues),
          );
        }
      }
    },
  };
}
