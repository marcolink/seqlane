import type { ActiveSession } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { Effect, Stream } from "effect";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import {
  AcpAdapterError,
  AcpStructuredOutputError,
  type AcpStructuredOutputIssue,
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
import type { AcpToolReducer } from "./stream.js";
import type { AcpTransport } from "./transport.js";
import { awaitSdkWithin } from "./bounded-sdk-wait.js";
import {
  awaitAbort,
  abortError,
  interactionError,
  reportDiagnostic,
} from "./adapter-helpers.js";

const CANCEL_CONFIRM_TIMEOUT_MS = 2_000;
const textEncoder = new TextEncoder();

async function confirmPromptStop(
  transport: AcpTransport,
  session: ActiveSession,
  promptResult: Promise<unknown>,
  request: AgentAdapterRequest,
): Promise<
  | { readonly promptRejected: false }
  | { readonly promptRejected: true; readonly cause: unknown }
> {
  let cancelFailure: unknown;
  try {
    const cancelRequest = transport.context.notify(
      methods.agent.session.cancel,
      {
        sessionId: session.sessionId,
      },
    );
    void cancelRequest.catch(() => undefined);
    const cancelResult = await awaitSdkWithin(
      cancelRequest,
      CANCEL_CONFIRM_TIMEOUT_MS,
    );
    if (cancelResult.timedOut)
      cancelFailure = new Error("ACP cancel notification timed out");
  } catch (cause) {
    cancelFailure = cause;
  }
  const settled = await awaitSdkWithin(
    promptResult.then(
      () => ({ status: "resolved" as const }),
      (cause: unknown) => ({ status: "rejected" as const, cause }),
    ),
    CANCEL_CONFIRM_TIMEOUT_MS,
  );
  if (!settled.timedOut) {
    if (settled.value.status === "resolved") return { promptRejected: false };
    const termination = transport.close();
    try {
      request.onUncertainActivity?.({ reason: "disconnect", termination });
    } catch {
      // The runtime still receives the termination promise through this failure.
    }
    try {
      await termination;
    } catch (terminationCause) {
      throw new AcpAdapterError(
        "cancellation",
        "ACP prompt failed and process termination were not confirmed",
        new AggregateError([settled.value.cause, terminationCause]),
      );
    }
    return { promptRejected: true, cause: settled.value.cause };
  }

  const termination = transport.close();
  try {
    request.onUncertainActivity?.({ reason: "timeout", termination });
  } catch {
    // The runtime still receives the termination promise through this failure.
  }
  try {
    await termination;
  } catch (terminationCause) {
    throw new AcpAdapterError(
      "cancellation",
      "ACP prompt cancellation and process termination were not confirmed",
      new AggregateError([
        request.signal.reason,
        cancelFailure,
        terminationCause,
      ]),
    );
  }
  return { promptRejected: false };
}

export async function runPrompt(
  transport: AcpTransport,
  session: ActiveSession,
  prompt: string,
  request: AgentAdapterRequest,
  reducer: AcpToolReducer,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw abortError(request);
  const settledPrompt = session.prompt([{ type: "text", text: prompt }]);
  void settledPrompt.catch(() => undefined);
  let responseText = "";
  let responseBytes = 0;
  let stopResponse: Awaited<typeof settledPrompt> | undefined;

  async function* sessionMessages() {
    while (true) {
      const message = await session.nextUpdate();
      yield message;
      if (message.kind === "stop") return;
    }
  }

  const consume = Stream.fromAsyncIterable(
    sessionMessages(),
    (cause) => cause,
  ).pipe(
    Stream.runForEachWhile((message) =>
      Effect.sync(() => {
        if (message.kind === "stop") {
          stopResponse = message.response;
          return false;
        }
        reducer.consume(message.update, message.notification);
        if (message.update.sessionUpdate === "agent_message_chunk") {
          const text =
            message.update.content.type === "text"
              ? message.update.content.text
              : undefined;
          if (text !== undefined) {
            const textBytes = textEncoder.encode(text).byteLength;
            if (textBytes > MAX_RESPONSE_TEXT_LENGTH - responseBytes) {
              throw new AcpAdapterError(
                "limit",
                `ACP response text exceeded ${MAX_RESPONSE_TEXT_LENGTH} bytes`,
              );
            }
            responseBytes += textBytes;
            responseText += text;
          }
        }
        return true;
      }),
    ),
  );
  const promptFailure = Effect.flatMap(
    Effect.promise(() => settledPrompt),
    () => Effect.never,
  );

  try {
    await Effect.runPromise(
      Effect.raceFirst(
        consume,
        Effect.raceFirst(promptFailure, awaitAbort(signal)),
      ),
    );
    const response = stopResponse ?? (await settledPrompt);
    if (transport.interactionRequested()) {
      reducer.finishAttempt("cancelled");
      throw interactionError(undefined);
    }
    if (response.stopReason === "cancelled") {
      if (request.signal.aborted) throw abortError(request);
      reducer.finishAttempt("cancelled");
      throw new AcpAdapterError("execution", "ACP agent cancelled the prompt");
    }
    reducer.finishAttempt("failed");
    return responseText;
  } catch (cause) {
    const abortedByCaller = request.signal.aborted;
    const transportFailure = transport.failure();
    const failure = transportFailure.failed ? transportFailure.cause : cause;
    let stopFailure: unknown;
    let hasStopFailure = false;
    let promptStop: Awaited<ReturnType<typeof confirmPromptStop>> = {
      promptRejected: false,
    };
    try {
      promptStop = await confirmPromptStop(
        transport,
        session,
        settledPrompt,
        request,
      );
    } catch (cleanupCause) {
      hasStopFailure = true;
      stopFailure = cleanupCause;
    }
    const promptRejectionCause = promptStop.promptRejected
      ? [promptStop.cause]
      : [];
    // A prompt stop or confirmed process-tree termination proves no later tool
    // update can arrive. Do not emit terminal activity before that boundary.
    if (!hasStopFailure) {
      try {
        reducer.finishAttempt(abortedByCaller ? "cancelled" : "failed");
      } catch (observerCause) {
        hasStopFailure = true;
        stopFailure = observerCause;
      }
    }
    if (transport.interactionRequested()) {
      throw interactionError(
        new AggregateError(
          [
            failure,
            ...promptRejectionCause,
            ...(hasStopFailure ? [stopFailure] : []),
          ],
          "ACP interaction was denied and prompt cleanup may be incomplete",
        ),
      );
    }
    if (abortedByCaller) {
      throw new AcpAdapterError(
        "cancellation",
        "ACP prompt was cancelled",
        new AggregateError([
          request.signal.reason,
          failure,
          ...(promptStop.promptRejected ? [promptStop.cause] : []),
          ...(hasStopFailure ? [stopFailure] : []),
        ]),
      );
    }
    if (failure instanceof AcpAdapterError) {
      if (!hasStopFailure && !promptStop.promptRejected) throw failure;
      throw new AcpAdapterError(
        failure.code,
        failure.message,
        new AggregateError([
          failure,
          ...promptRejectionCause,
          ...(hasStopFailure ? [stopFailure] : []),
        ]),
      );
    }
    if (hasStopFailure) {
      throw new AcpAdapterError(
        "execution",
        "ACP prompt failed and cleanup also failed",
        new AggregateError([failure, ...promptRejectionCause, stopFailure]),
      );
    }
    throw new AcpAdapterError(
      "execution",
      "ACP prompt failed",
      promptStop.promptRejected
        ? new AggregateError([failure, ...promptRejectionCause])
        : failure,
    );
  }
}

export async function executePromptTask(input: {
  readonly request: AgentAdapterRequest;
  readonly transport: AcpTransport;
  readonly session: ActiveSession;
  readonly reducer: AcpToolReducer;
  readonly signal: AbortSignal;
  readonly retryCount: number;
}): Promise<unknown> {
  const { request, transport, session, reducer, signal, retryCount } = input;
  const taskPrompt = buildAgentPrompt(
    request.task,
    request.input,
    request.agent,
  );
  const schema = toJsonSchema(request.task);
  let prompt = buildStructuredOutputPrompt(taskPrompt, schema);
  let attempts = 0;
  const startedAt = Date.now();
  while (true) {
    signal.throwIfAborted();
    attempts += 1;
    if (attempts === 1) request.onExecutionStarted();
    const promptSignal = AbortSignal.any([
      request.signal,
      transport.signal,
      transport.interactionSignal(),
    ]);
    const text = await runPrompt(
      transport,
      session,
      prompt,
      request,
      reducer,
      promptSignal,
    );
    request.onMetrics?.({
      durationMs: Math.max(0, Date.now() - startedAt),
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
              ] satisfies readonly AcpStructuredOutputIssue[],
              cause,
            );
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
        summarizeStructuredOutputIssues(validationError.issues),
      );
      reportDiagnostic(
        request,
        "structured-output",
        `ACP structured output was repaired after attempt ${attempts}`,
      );
    }
  }
}
