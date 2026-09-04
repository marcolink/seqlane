import { AcpAgent as MastraAcpAgent, type AcpAgentOptions } from "@mastra/acp";
import type { AgentStreamOptions } from "@mastra/core/agent";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import {
  InteractionRequiredError,
  type TaskDefinitionRegistry,
} from "@seqlane/core";
import {
  type AcpExecutor,
  type AcpExecutorOptions,
  type AcpExecutorRequest,
  type AcpLaunchConfiguration,
  parseAcpLaunchConfiguration,
} from "./contracts.js";
import { AcpAdapterError, AcpStructuredOutputError } from "./errors.js";
import {
  parseStructuredOutput,
  summarizeStructuredOutputIssues,
  validateStructuredOutput,
} from "./output.js";
import {
  buildAgentPrompt,
  buildStructuredOutputPrompt,
  buildStructuredOutputRepairPrompt,
} from "./prompt.js";
import { getAgentTask, toJsonSchema } from "./task.js";
import { reportAcpStreamChunk } from "./stream.js";

interface AcpStream {
  readonly fullStream: ReadableStream<unknown>;
  readonly text: Promise<string>;
}

interface AcpAgent {
  stream(
    messages: MessageListInput,
    options: Pick<AgentStreamOptions, "abortSignal" | "runId">,
  ): Promise<AcpStream>;
}

type CreateAcpAgent = (options: AcpAgentOptions) => AcpAgent;

function createDefaultAgent(options: AcpAgentOptions): AcpAgent {
  return new MastraAcpAgent(options);
}

async function streamAgent(
  agent: AcpAgent,
  prompt: string,
  request: AcpExecutorRequest,
): Promise<string> {
  const stream = await agent.stream([{ role: "user", content: prompt }], {
    abortSignal: request.signal,
    runId: request.invocationId,
  });
  const reader = stream.fullStream.getReader();
  const activities = new Map<string, string>();
  let removeAbortListener = (): void => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      request.signal.removeEventListener("abort", onAbort);
      reject(request.signal.reason ?? new Error("ACP execution aborted"));
    };
    removeAbortListener = () =>
      request.signal.removeEventListener("abort", onAbort);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), cancellation]);
      if (next.done) break;
      reportAcpStreamChunk(next.value, activities, request.onActivity);
    }
  } catch (cause) {
    await stream.text.catch(() => undefined);
    throw cause;
  } finally {
    removeAbortListener();
    reader.releaseLock();
  }
  return stream.text;
}

export function createAcpExecutor(
  tasks: TaskDefinitionRegistry,
  configuration: AcpLaunchConfiguration,
  options: AcpExecutorOptions & {
    readonly createAgent?: CreateAcpAgent;
  } = {},
): AcpExecutor {
  const validatedConfiguration = parseAcpLaunchConfiguration(configuration);
  const createAgent = options.createAgent ?? createDefaultAgent;
  let permissionRequested = false;
  const agent = createAgent({
    ...validatedConfiguration,
    onPermissionRequest: async () => {
      permissionRequested = true;
      return { outcome: { outcome: "cancelled" } };
    },
  });
  const retryCount = options.structuredOutputRetryCount ?? 0;

  return {
    async execute(request) {
      permissionRequested = false;
      const task = getAgentTask(tasks, request.taskId);
      const schema = toJsonSchema(task);
      let prompt = buildStructuredOutputPrompt(
        buildAgentPrompt(task, request.input),
        schema,
      );
      let attempts = 0;
      let lastError: AcpStructuredOutputError | undefined;
      const startedAt = Date.now();

      while (true) {
        attempts += 1;
        let text: string;
        try {
          text = await streamAgent(agent, prompt, request);
        } catch (cause) {
          if (permissionRequested) {
            throw new InteractionRequiredError("user-input");
          }
          if (request.signal.aborted) {
            throw new AcpAdapterError(
              "cancellation",
              "execution was cancelled",
              cause,
            );
          }
          if (cause instanceof AcpAdapterError) throw cause;
          throw new AcpAdapterError(
            "execution",
            "stream execution failed",
            cause,
          );
        }
        if (permissionRequested) {
          throw new InteractionRequiredError("user-input");
        }
        request.onMetrics?.({
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(validatedConfiguration.model === undefined
            ? {}
            : { model: validatedConfiguration.model }),
        });
        try {
          return validateStructuredOutput(
            parseStructuredOutput(text),
            task.output,
          );
        } catch (cause) {
          const validationError =
            cause instanceof AcpStructuredOutputError
              ? cause
              : new AcpStructuredOutputError(
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
          lastError = validationError;
          if (attempts > retryCount) {
            throw new AcpStructuredOutputError(
              attempts,
              validationError.issues,
              validationError,
            );
          }
          prompt = buildStructuredOutputRepairPrompt(
            summarizeStructuredOutputIssues(lastError.issues),
          );
          request.onDiagnostic?.({
            code: "structured-output",
            message: `ACP structured output was repaired after attempt ${attempts}`,
          });
        }
      }
    },
  };
}
