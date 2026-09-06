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
  AcpMalformedStreamError,
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
import {
  MAX_ACTIVITY_COUNT,
  MAX_ACTIVITY_INPUT_LENGTH,
  reportAcpStreamChunk,
} from "./stream.js";

const STREAM_CLEANUP_TIMEOUT_MS = 100;
const textEncoder = new TextEncoder();

type TextResult =
  | { readonly status: "fulfilled"; readonly value: string }
  | { readonly status: "rejected"; readonly cause: unknown };

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

function readTextDelta(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "text-delta"
  ) {
    return undefined;
  }

  if (
    !("payload" in value) ||
    typeof value.payload !== "object" ||
    value.payload === null ||
    !("text" in value.payload) ||
    typeof value.payload.text !== "string"
  ) {
    throw new AcpMalformedStreamError("text-delta");
  }

  return value.payload.text;
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
    stream: (messages, streamOptions) => agent.stream(messages, streamOptions),
  };
}

async function streamAgent(
  agent: AcpAgent,
  prompt: string,
  request: AgentAdapterRequest,
): Promise<string> {
  const stream = await agent.stream([{ role: "user", content: prompt }], {
    abortSignal: request.signal,
    runId: request.invocationId,
  });
  const textResult: Promise<TextResult> = stream.text.then(
    (value) => ({ status: "fulfilled", value }),
    (cause) => ({ status: "rejected", cause }),
  );
  const reader = stream.fullStream.getReader();
  const activities = new Map<string, string>();
  let activityCount = 0;
  let activityInputLength = 0;
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
  try {
    while (true) {
      const next = await Promise.race([readNext(), cancellation]);
      if (next.done) break;
      const textDelta = readTextDelta(next.value);
      if (textDelta !== undefined) {
        if (textDelta.length > MAX_RESPONSE_TEXT_LENGTH - responseTextBytes) {
          throw new AcpLimitError("response text", MAX_RESPONSE_TEXT_LENGTH);
        }
        responseTextBytes += textEncoder.encode(textDelta).byteLength;
        if (responseTextBytes > MAX_RESPONSE_TEXT_LENGTH) {
          throw new AcpLimitError("response text", MAX_RESPONSE_TEXT_LENGTH);
        }
      }
      reportAcpStreamChunk(next.value, activities, (activity) => {
        activityCount += 1;
        if (activityCount > MAX_ACTIVITY_COUNT) {
          throw new AcpLimitError("activity count", MAX_ACTIVITY_COUNT);
        }
        if (typeof activity.input === "string") {
          activityInputLength += activity.input.length;
          if (activityInputLength > MAX_ACTIVITY_INPUT_LENGTH) {
            throw new AcpLimitError(
              "activity input",
              MAX_ACTIVITY_INPUT_LENGTH,
            );
          }
        }
        request.onActivity?.(activity);
      });
    }
    const result = await textResult;
    if (result.status === "rejected") throw result.cause;
    if (
      textEncoder.encode(result.value).byteLength > MAX_RESPONSE_TEXT_LENGTH
    ) {
      throw new AcpLimitError("response text", MAX_RESPONSE_TEXT_LENGTH);
    }
    return result.value;
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    removeAbortListener();
    if (failed) {
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
      if (request.modelSelection !== undefined) {
        throw new AcpAdapterError(
          "configuration",
          "dynamic model selection is not supported by ACP",
        );
      }
      permissionRequested = false;
      const schema = toJsonSchema(request.task);
      let prompt = buildStructuredOutputPrompt(
        buildAgentPrompt(request.task, request.input),
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
            summarizeStructuredOutputIssues(lastError.issues),
          );
          request.onDiagnostic?.({
            code: "structured-output",
            message: `ACP structured output was repaired after attempt ${attempts}`,
          });
        }
      }
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
