import { InteractionRequiredError } from "@seqlane/core";
import type { ModelSelection } from "@seqlane/core";
import { z } from "zod";
import { OpenCodeExecutorError } from "./errors.js";
import { StructuredOutputCompatibilityError } from "./errors.js";
import { parseOpenCodePromptResponse } from "./prompt-response.js";
import type {
  OpenCodeConnection,
  OpenCodeActivity,
  OpenCodeUncertainActivity,
  OpenCodePrompt,
  OpenCodePromptResult,
  OpenCodeRun,
} from "./protocol.js";
import { createOpenCodeTransport, type OpenCodeSession } from "./transport.js";
import { createOpenCodeSessionBrowserUrl } from "./session-browser-url.js";
import {
  createStructuredOutputState,
  type StructuredOutputState,
} from "./structured-output-strategy.js";
import { isNativeReadbackCompatibilityError } from "./structured-output-compatibility.js";
import { parseOpenCodeEvent } from "./observations.js";
import type { OpenCodeEventObservation } from "./observations.js";
import { createAttemptTransitionDispatcher } from "./attempt-transitions.js";

const checkpointSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
});
const runAbortTimeoutMs = 2_000;

const structuredOutputStates = new WeakMap<
  OpenCodeConnection,
  StructuredOutputState
>();

type InteractionMonitorResult =
  | { readonly type: "interaction" }
  | { readonly type: "monitor-error"; readonly cause: unknown };

async function closeInteractionMonitor(
  controller: AbortController,
  removeAbortListener: () => void,
  monitor: Promise<InteractionMonitorResult> | undefined,
): Promise<void> {
  controller.abort();
  removeAbortListener();
  if (monitor === undefined) return;
  const result = await monitor;
  if (result.type === "monitor-error") {
    throw executorError(
      "could not monitor external interaction requirements",
      result.cause,
    );
  }
}

async function waitForInteraction(
  events: AsyncIterable<unknown>,
  sessionID: string,
  signal: AbortSignal,
  onActivity: ((activity: OpenCodeActivity) => void) | undefined,
  onUncertainActivity:
    ((activity: OpenCodeUncertainActivity) => void) | undefined,
  onObservation: ((observation: OpenCodeEventObservation) => void) | undefined,
  onDiagnostic: ((message: string) => void) | undefined,
): Promise<void> {
  const dispatcher = createAttemptTransitionDispatcher({
    onActivity,
    onObservation,
  });
  const reportDiagnostic = (message: string): void => {
    try {
      onDiagnostic?.(message);
    } catch {
      // Diagnostics are best effort and must not affect execution.
    }
  };
  for await (const event of events) {
    const parsed = parseOpenCodeEvent(event, sessionID);
    if (parsed === undefined) {
      reportDiagnostic("ignored malformed OpenCode event");
      continue;
    }
    if (parsed.interaction) return;
    const observation = parsed.observation;
    if (observation !== undefined) {
      dispatcher.observation(observation);
      continue;
    }
    if (parsed.legacyTool !== undefined) {
      dispatcher.legacyTool(parsed.legacyTool);
    }
    if (parsed.backgroundProcess) {
      // OpenCode's event does not expose a lifetime handle for this process.
      // Quarantine the session instead of passing an untrackable mutation into
      // the runtime.
      onUncertainActivity?.({ reason: "disconnect" });
    }
    if (parsed.validity === "unsupported")
      reportDiagnostic("ignored unsupported OpenCode event");
    else if (parsed.validity === "malformed")
      reportDiagnostic("ignored malformed OpenCode event");
  }
  if (!signal.aborted) {
    throw new OpenCodeExecutorError(
      "interaction monitor closed before task completion",
    );
  }
}

export type {
  OpenCodeConnection,
  OpenCodeActivity,
  OpenCodePrompt,
  OpenCodePromptResult,
  OpenCodeRun,
  OpenCodeUncertainActivity,
} from "./protocol.js";

function executorError(message: string, cause?: unknown): Error {
  return new OpenCodeExecutorError(message, cause);
}

function createRunCloser(
  queue: () => Promise<void>,
  cancel: () => Promise<void>,
) {
  let closed = false;
  let closePromise: Promise<void> | undefined;
  return {
    assertOpen(): void {
      if (closed) throw executorError("run is closed");
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        const [cancelled, drained] = await Promise.allSettled([
          cancel(),
          queue(),
        ]);
        if (cancelled.status === "rejected") throw cancelled.reason;
        if (drained.status === "rejected") throw drained.reason;
      })();
      return closePromise;
    },
  };
}

interface PromptCancellation {
  readonly monitorController: AbortController;
  readonly monitorSignal: AbortSignal;
  readonly promptController: AbortController;
  readonly promptSignal: AbortSignal;
  readonly result?: Promise<void>;
  readonly removeRequestListener: () => void;
}

function createPromptCancellation(
  runSignal: AbortSignal,
  requestSignal: AbortSignal | undefined,
  abort: () => Promise<void>,
): PromptCancellation {
  const promptController = new AbortController();
  const monitorController = new AbortController();
  let removeRequestListener = (): void => undefined;
  const result = requestSignal
    ? new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          requestSignal.removeEventListener("abort", onAbort);
          promptController.abort();
          monitorController.abort();
          void abort().then(resolve, reject);
        };
        removeRequestListener = () =>
          requestSignal.removeEventListener("abort", onAbort);
        if (requestSignal.aborted) onAbort();
        else requestSignal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  return {
    monitorController,
    monitorSignal: AbortSignal.any([monitorController.signal, runSignal]),
    promptController,
    promptSignal: AbortSignal.any([promptController.signal, runSignal]),
    result,
    removeRequestListener,
  };
}

function getStructuredOutputState(
  connection: OpenCodeConnection,
  transport: ReturnType<typeof createOpenCodeTransport>,
): StructuredOutputState {
  const existing = structuredOutputStates.get(connection);
  if (existing !== undefined) return existing;
  const state = createStructuredOutputState({
    configuration: connection.structuredOutput,
    resolveVersion: () =>
      transport.getRuntimeVersion?.() ?? Promise.resolve(undefined),
  });
  structuredOutputStates.set(connection, state);
  return state;
}

export async function createOpenCodeRun(
  connection: OpenCodeConnection,
  signal?: AbortSignal,
  configuredSelection?: ModelSelection,
): Promise<OpenCodeRun> {
  return createOpenCodeRunForSession(
    connection,
    signal,
    undefined,
    configuredSelection,
  );
}

async function createOpenCodeRunForSession(
  connection: OpenCodeConnection,
  signal?: AbortSignal,
  existingSession?: OpenCodeSession,
  configuredSelection?: ModelSelection,
  structuredOutputState?: StructuredOutputState,
): Promise<OpenCodeRun> {
  if (signal?.aborted) {
    throw executorError("run was cancelled before session creation");
  }

  const transport = createOpenCodeTransport(connection.url);
  const outputState =
    structuredOutputState ??
    connection.structuredOutputState ??
    getStructuredOutputState(connection, transport);
  let sessionID: string;
  let workspace: string | undefined;
  let browserUrl: string | undefined;
  try {
    const session =
      existingSession ??
      (await transport.createSession(connection.workspace, signal));
    sessionID = session.sessionId;
    workspace = session.workspace;
    browserUrl =
      connection.browserUiUrl === undefined
        ? undefined
        : createOpenCodeSessionBrowserUrl(
            connection.browserUiUrl,
            session.directory,
            session.sessionId,
          );
    if (signal?.aborted) {
      throw executorError("run was cancelled during session creation");
    }
  } catch (cause) {
    throw executorError("could not create an external session", cause);
  }

  let queue = Promise.resolve();
  let aborted = false;
  const runController = new AbortController();
  const closer = createRunCloser(
    () => queue,
    async () => {
      runController.abort();
      await abort();
    },
  );
  let abortPromise: Promise<void> | undefined;
  let terminalCheckpoint: z.infer<typeof checkpointSchema> | undefined;
  let eventDiagnosticCount = 0;
  let eventDiagnosticSuppressionReported = false;
  const reportEventDiagnostic = (
    callback: ((message: string) => void) | undefined,
    message: string,
  ): void => {
    if (eventDiagnosticCount < 8) {
      eventDiagnosticCount += 1;
      callback?.(message);
      return;
    }
    if (eventDiagnosticSuppressionReported) return;
    eventDiagnosticSuppressionReported = true;
    callback?.(
      "suppressed additional malformed or unsupported OpenCode event diagnostics",
    );
  };

  const prompt = (request: OpenCodePrompt): Promise<OpenCodePromptResult> => {
    const operation = queue.then(async () => {
      closer.assertOpen();
      if (aborted || signal?.aborted || request.signal?.aborted) {
        throw executorError("run was cancelled before task submission");
      }

      try {
        const selected = await outputState.resolve();
        const effectiveStrategy = request.strategy ?? selected.strategy;
        const cancellation = createPromptCancellation(
          runController.signal,
          request.signal,
          abort,
        );
        let interactionRequest: Promise<InteractionMonitorResult> | undefined;
        try {
          let events: AsyncIterable<unknown>;
          try {
            events = await transport.monitorSession(
              sessionID,
              cancellation.monitorSignal,
            );
          } catch (cause) {
            throw executorError(
              "could not monitor external interaction requirements",
              cause,
            );
          }
          interactionRequest = waitForInteraction(
            events,
            sessionID,
            cancellation.monitorSignal,
            request.onActivity,
            request.onUncertainActivity,
            request.onObservation,
            (message) => reportEventDiagnostic(request.onDiagnostic, message),
          )
            .then(() => ({ type: "interaction" as const }))
            .catch((cause) => ({ type: "monitor-error" as const, cause }));
          const effectiveRequest: OpenCodePrompt = {
            ...request,
            strategy: effectiveStrategy,
            retryCount: selected.retryCount,
            ...(configuredSelection === undefined
              ? {}
              : {
                  selection: configuredSelection,
                  ...(configuredSelection.reasoning === undefined
                    ? {}
                    : { variant: configuredSelection.reasoning }),
                }),
          };
          const promptResponse = transport
            .prompt(sessionID, effectiveRequest, cancellation.promptSignal)
            .then(
              (response) => ({ type: "response" as const, response }),
              (cause: unknown) => ({ type: "transport-error" as const, cause }),
            );
          const result = await Promise.race([
            promptResponse,
            interactionRequest,
            ...(cancellation.result === undefined
              ? []
              : [
                  cancellation.result.then(() => ({
                    type: "cancelled" as const,
                  })),
                ]),
          ]);
          if (request.signal?.aborted && cancellation.result !== undefined) {
            await cancellation.result;
            throw executorError("run was cancelled during task submission");
          }

          if (result.type === "cancelled") {
            throw executorError("run was cancelled during task submission");
          }

          if (result.type === "monitor-error") {
            request.onRunInvalidated?.();
            cancellation.promptController.abort();
            await abort().catch(() => undefined);
            throw executorError(
              "could not monitor external interaction requirements",
              result.cause,
            );
          }

          if (result.type === "interaction") {
            request.onRunInvalidated?.();
            cancellation.promptController.abort();
            await abort().catch(() => undefined);
            await promptResponse.catch(() => undefined);
            throw new InteractionRequiredError("user-input");
          }

          if (result.type === "transport-error") {
            if (
              effectiveStrategy === "native" &&
              isNativeReadbackCompatibilityError(result.cause)
            ) {
              outputState.markNativeReadbackIncompatible(selected.version);
              throw new StructuredOutputCompatibilityError(
                selected.version,
                sessionID,
                result.cause,
              );
            }
            request.onUncertainActivity?.({ reason: "disconnect" });
            throw executorError("structured task request failed", result.cause);
          }

          const parsed = parseOpenCodePromptResponse(
            result.response,
            effectiveStrategy,
          );
          if (parsed.checkpoint.sessionId !== sessionID) {
            throw executorError("prompt response belonged to another session");
          }
          if (effectiveStrategy === "native" && transport.listMessages) {
            try {
              await transport.listMessages(
                sessionID,
                cancellation.promptSignal,
              );
            } catch (cause) {
              if (isNativeReadbackCompatibilityError(cause)) {
                outputState.markNativeReadbackIncompatible(selected.version);
                throw new StructuredOutputCompatibilityError(
                  selected.version,
                  sessionID,
                  cause,
                );
              }
              throw executorError("could not read the external session", cause);
            }
          }
          terminalCheckpoint = parsed.checkpoint;
          return {
            structured: parsed.structured,
            ...(parsed.text === undefined ? {} : { text: parsed.text }),
            ...(parsed.metrics === undefined
              ? {}
              : { metrics: parsed.metrics }),
            ...(parsed.observation === undefined
              ? {}
              : { observation: parsed.observation }),
          };
        } finally {
          await closeInteractionMonitor(
            cancellation.monitorController,
            cancellation.removeRequestListener,
            interactionRequest,
          );
        }
      } catch (cause) {
        if (cause instanceof InteractionRequiredError) throw cause;
        if (
          cause instanceof OpenCodeExecutorError ||
          cause instanceof StructuredOutputCompatibilityError
        )
          throw cause;
        throw executorError("structured task request failed", cause);
      }
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const abort = (): Promise<void> => {
    if (abortPromise) return abortPromise;
    aborted = true;
    abortPromise = transport
      .abort(sessionID, AbortSignal.timeout(runAbortTimeoutMs))
      .then(() => undefined)
      .catch((cause) => {
        throw executorError("could not abort the external session", cause);
      });
    return abortPromise;
  };

  const checkpoint = async (): Promise<z.infer<typeof checkpointSchema>> => {
    if (terminalCheckpoint === undefined) {
      throw executorError("session has no terminal message checkpoint");
    }
    return terminalCheckpoint;
  };

  const fork = async (
    checkpointInput: unknown,
    selection?: ModelSelection,
  ): Promise<OpenCodeRun> => {
    const checkpoint = checkpointSchema.safeParse(checkpointInput);
    if (!checkpoint.success || checkpoint.data.sessionId !== sessionID) {
      throw executorError("session checkpoint does not belong to this session");
    }
    try {
      const child = await transport.forkSession(
        sessionID,
        checkpoint.data.messageId,
        signal,
      );
      if (selection !== undefined) {
        await transport.configureSession(
          child.sessionId,
          { messageId: checkpoint.data.messageId, selection },
          signal,
        );
      }
      return createOpenCodeRunForSession(
        connection,
        signal,
        {
          ...child,
          ...(workspace === undefined ? {} : { workspace }),
        },
        selection,
        outputState,
      );
    } catch (cause) {
      throw executorError("native session checkpoint fork failed", cause);
    }
  };

  return {
    ...(browserUrl === undefined ? {} : { browserUrl }),
    ...(workspace === undefined ? {} : { workspace }),
    prompt,
    structuredOutput: async () => {
      const selected = await outputState.resolve();
      return {
        strategy: selected.strategy,
        retryCount: selected.retryCount,
        reason: selected.reason,
        ...(selected.version === undefined
          ? {}
          : { version: selected.version }),
        report: selected.report,
      };
    },
    checkpoint,
    fork,
    abort,
    close: closer.close,
  };
}
