import { AcpAgent as MastraAcpAgent } from "@mastra/acp";
import { InteractionRequiredError } from "@seqlane/core";
import type { AgentAdapter, AgentAdapterRequest } from "@seqlane/agent-adapter";
import {
  type AcpAgent,
  type AcpAgentFactoryOptions,
  type AcpExecutorOptions,
  type AcpLaunchConfiguration,
  parseAcpLaunchConfiguration,
} from "./contracts.js";
import {
  AcpAdapterError,
  AcpLimitError,
  AcpStructuredOutputError,
} from "./errors.js";
import {
  MAX_RESPONSE_TEXT_LENGTH,
  parseStructuredOutput,
  summarizeStructuredOutputIssues,
  validateStructuredOutput,
} from "./output.js";
import {
  buildAgentPrompt,
  buildStructuredOutputPrompt,
  buildStructuredOutputRepairPrompt,
} from "./prompt.js";
import { toJsonSchema } from "./task.js";
import { AcpToolReducer } from "./stream.js";
import { createAcpObservability } from "./observability.js";

const STREAM_CLEANUP_TIMEOUT_MS = 100;
const textEncoder = new TextEncoder();

type TextResult =
  | { readonly status: "fulfilled"; readonly value: string }
  | { readonly status: "rejected"; readonly cause: unknown };

interface PermissionScope {
  requested: boolean;
  rejectInteraction?: (reason?: unknown) => void;
}

interface AgentPermissionScope {
  current?: PermissionScope;
}

function createExecutionQueue(): <T>(
  operation: () => Promise<T>,
) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const execution = tail.then(operation);
    tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  };
}

async function boundedCleanup(
  promises: readonly PromiseLike<unknown>[],
): Promise<void> {
  const cleanup = Promise.allSettled(promises);
  await Promise.race([
    cleanup,
    new Promise<void>((resolve) =>
      setTimeout(resolve, STREAM_CLEANUP_TIMEOUT_MS),
    ),
  ]);
}

function disconnectAgent(agent: AcpAgent): void {
  try {
    agent.disconnect?.();
  } catch {
    // Preserve the stream failure that requires this best-effort teardown.
  }
}

function createDefaultAgent(options: AcpAgentFactoryOptions): AcpAgent {
  const agent = new MastraAcpAgent({
    ...options,
    ...(options.onPermissionRequest === undefined
      ? {}
      : {
          onPermissionRequest: async (request) => {
            const response = await options.onPermissionRequest?.(request);
            return response ?? { outcome: { outcome: "cancelled" } };
          },
        }),
  });
  return {
    disconnect: () => agent.connection.disconnect(),
    stream: (messages, streamOptions) => agent.stream(messages, streamOptions),
  };
}

async function streamAgent(
  agent: AcpAgent,
  prompt: string,
  request: AgentAdapterRequest,
  interaction: Promise<never>,
  attemptIndex: number,
  reducer: AcpToolReducer,
): Promise<string> {
  const streamAbortController = new AbortController();
  const streamSignal = AbortSignal.any([
    request.signal,
    streamAbortController.signal,
  ]);
  let stream: Awaited<ReturnType<AcpAgent["stream"]>>;
  try {
    stream = await agent.stream([{ role: "user", content: prompt }], {
      abortSignal: streamSignal,
      runId: request.invocationId,
    });
  } catch (cause) {
    disconnectAgent(agent);
    throw cause;
  }
  const textResult: Promise<TextResult> = stream.text.then(
    (value) => ({ status: "fulfilled", value }),
    (cause) => ({ status: "rejected", cause }),
  );
  const reader = stream.fullStream.getReader();
  let responseTextBytes = 0;
  let activeRead: Promise<ReadableStreamReadResult<unknown>> | undefined;
  let readSettled = true;
  let readerReleased = false;
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
  const releaseReader = (): void => {
    if (!readerReleased && readSettled) {
      readerReleased = true;
      reader.releaseLock();
    }
  };
  const readNext = (): Promise<ReadableStreamReadResult<unknown>> => {
    const next = reader.read();
    activeRead = next;
    readSettled = false;
    void next.then(
      () => {
        if (activeRead === next) {
          readSettled = true;
          activeRead = undefined;
        }
      },
      () => {
        if (activeRead === next) {
          readSettled = true;
          activeRead = undefined;
        }
      },
    );
    return next;
  };
  let failed = false;
  let failure: unknown;
  try {
    while (true) {
      const next = await Promise.race([readNext(), cancellation, interaction]);
      if (next.done) break;
      const chunk = reducer.consume(next.value, attemptIndex);
      const textDelta =
        chunk?.type === "text-delta" ? chunk.payload.text : undefined;
      if (textDelta !== undefined) {
        if (textDelta.length > MAX_RESPONSE_TEXT_LENGTH - responseTextBytes) {
          throw new AcpLimitError("response text", MAX_RESPONSE_TEXT_LENGTH);
        }
        responseTextBytes += textEncoder.encode(textDelta).byteLength;
        if (responseTextBytes > MAX_RESPONSE_TEXT_LENGTH) {
          throw new AcpLimitError("response text", MAX_RESPONSE_TEXT_LENGTH);
        }
      }
    }
    const result = await Promise.race([textResult, interaction]);
    if (result.status === "rejected") throw result.cause;
    if (
      textEncoder.encode(result.value).byteLength > MAX_RESPONSE_TEXT_LENGTH
    ) {
      throw new AcpLimitError("response text", MAX_RESPONSE_TEXT_LENGTH);
    }
    reducer.finishAttempt(attemptIndex, "incomplete");
    return result.value;
  } catch (cause) {
    failed = true;
    failure = cause;
    reducer.finishAttempt(
      attemptIndex,
      request.signal.aborted ? "cancelled" : "failure",
    );
    throw cause;
  } finally {
    removeAbortListener();
    if (failed) {
      streamAbortController.abort(failure);
      disconnectAgent(agent);
      const cancel = reader.cancel();
      void cancel.catch(() => undefined);
      await boundedCleanup([
        cancel,
        ...(activeRead === undefined ? [] : [activeRead]),
        textResult,
      ]);
      if (!readSettled && activeRead !== undefined) {
        const pendingRead = activeRead;
        void pendingRead.then(releaseReader, releaseReader);
      }
    }
    releaseReader();
  }
}

export function createAcpAdapter(
  configuration: AcpLaunchConfiguration,
  options: AcpExecutorOptions = {},
): AgentAdapter {
  const validatedConfiguration = parseAcpLaunchConfiguration(configuration);
  const createAgent = options.createAgent ?? createDefaultAgent;
  // @mastra/acp 0.4.0 has one ACPConnection.currentPrompt and one
  // agent-level permission callback. Keep one prompt active per adapter so
  // the callback can be associated with exactly one execution.
  const enqueueExecution = createExecutionQueue();
  const createAgentState = () => {
    const permissionScope: AgentPermissionScope = {};
    const agent = createAgent({
      ...validatedConfiguration,
      onPermissionRequest: async () => {
        const activePermissionScope = permissionScope.current;
        if (activePermissionScope !== undefined) {
          activePermissionScope.requested = true;
          activePermissionScope.rejectInteraction?.(
            new InteractionRequiredError("user-input"),
          );
        }
        return { outcome: { outcome: "cancelled" } };
      },
    });
    return { agent, permissionScope };
  };
  let agentState = createAgentState();
  const retryCount = options.structuredOutputRetryCount ?? 0;

  return {
    async execute(request) {
      const permissionScope: PermissionScope = { requested: false };
      return enqueueExecution(async () => {
        if (request.signal.aborted) {
          throw new AcpAdapterError(
            "cancellation",
            "execution was cancelled",
            request.signal.reason ?? new Error("ACP execution aborted"),
          );
        }
        const reportDiagnostic = (code: string, message: string): void => {
          try {
            request.onDiagnostic?.({ code, message });
          } catch {
            // Diagnostics are best effort and must not affect execution.
          }
        };
        const observability = createAcpObservability(
          request.observability,
          request.invocationId,
          (message) => reportDiagnostic("acp-observability", message),
        );
        const reducer = new AcpToolReducer(request.invocationId, {
          onActivity: (activity) => request.onActivity?.(activity),
          onToolOpened: observability.onToolOpened,
          onToolClosed: observability.onToolClosed,
          onDiagnostic: (diagnostic) =>
            reportDiagnostic(diagnostic.code, diagnostic.message),
        });
        let observabilityOutcome: "cancelled" | "failed" | undefined;
        agentState.permissionScope.current = permissionScope;
        try {
          if (request.modelSelection !== undefined) {
            throw new AcpAdapterError(
              "configuration",
              "dynamic model selection is not supported by ACP",
            );
          }
          const taskPrompt = buildAgentPrompt(
            request.task,
            request.input,
            request.agent,
          );
          const schema = toJsonSchema(request.task);
          let prompt = buildStructuredOutputPrompt(taskPrompt, schema);
          let attempts = 0;
          let lastError: AcpStructuredOutputError | undefined;
          const startedAt = Date.now();

          while (true) {
            attempts += 1;
            let text: string;
            const interaction = new Promise<never>((_resolve, reject) => {
              permissionScope.rejectInteraction = reject;
            });
            void interaction.catch(() => undefined);
            try {
              if (attempts === 1) request.onExecutionStarted();
              text = await streamAgent(
                agentState.agent,
                prompt,
                request,
                interaction,
                attempts - 1,
                reducer,
              );
            } catch (cause) {
              // A failed stream disconnects the ACP connection. Recreate the
              // private agent before the next queued execution while keeping
              // the failed agent's permission callback scoped to its run.
              agentState.permissionScope.current = undefined;
              agentState = createAgentState();
              if (permissionScope.requested) {
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
            } finally {
              permissionScope.rejectInteraction = undefined;
            }
            if (permissionScope.requested) {
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
                request.task.output,
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
                taskPrompt,
                schema,
                summarizeStructuredOutputIssues(lastError.issues),
              );
              request.onDiagnostic?.({
                code: "structured-output",
                message: `ACP structured output was repaired after attempt ${attempts}`,
              });
            }
          }
        } catch (cause) {
          observabilityOutcome = request.signal.aborted
            ? "cancelled"
            : "failed";
          throw cause;
        } finally {
          observability.finish(observabilityOutcome);
          if (agentState.permissionScope.current === permissionScope) {
            agentState.permissionScope.current = undefined;
          }
        }
      });
    },
    capabilities: {
      execute: true,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: validatedConfiguration.persistSession,
      checkpoint: false,
      fork: false,
      activity: true,
      sessionUi: false,
    },
  };
}
