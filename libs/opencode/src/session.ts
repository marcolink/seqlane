import { InteractionRequiredError } from "@seqlane/core";
import { Effect, Semaphore, Stream } from "effect";
import type { ModelSelection } from "@seqlane/core";
import { z } from "zod";
import { OpenCodeExecutorError } from "./errors.js";
import { StructuredOutputCompatibilityError } from "./errors.js";
import { parseOpenCodePromptResponse } from "./prompt-response.js";
import type {
  OpenCodeConnection,
  OpenCodeUncertainActivity,
  OpenCodePrompt,
  OpenCodePromptResult,
  OpenCodeRun,
} from "./protocol.js";
import {
  createOpenCodeTransport,
  type OpenCodeSession,
  type OpenCodeTransport,
} from "./transport.js";
import { createOpenCodeSessionBrowserUrl } from "./session-browser-url.js";
import {
  createStructuredOutputState,
  type StructuredOutputState,
} from "./structured-output-strategy.js";
import { isNativeReadbackCompatibilityError } from "./structured-output-compatibility.js";
import {
  parseOpenCodeEvent,
  parseOpenCodeMessageObservations,
} from "./observations.js";
import {
  createAttemptTransitionDispatcher,
  type AttemptTransitionDispatcher,
} from "./attempt-transitions.js";
import { awaitOwnedCleanup } from "./owned-cleanup.js";
import {
  runMonitoredPrompt,
  type MonitoredPromptResult,
} from "./monitored-prompt.js";

const checkpointSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
});
const runAbortTimeoutMs = 2_000;
const maxMessageHistoryPages = 10;

const structuredOutputStates = new WeakMap<
  OpenCodeConnection,
  StructuredOutputState
>();

function waitForInteraction(
  events: AsyncIterable<unknown>,
  sessionID: string,
  signal: AbortSignal,
  dispatcher: AttemptTransitionDispatcher,
  onUncertainActivity:
    ((activity: OpenCodeUncertainActivity) => void) | undefined,
  onDiagnostic: ((message: string) => void) | undefined,
  onStarted: () => void,
): Effect.Effect<boolean, unknown> {
  const reportDiagnostic = (message: string): void => {
    try {
      onDiagnostic?.(message);
    } catch {
      // Diagnostics are best effort and must not affect execution.
    }
  };
  let interaction = false;
  const startedEvents: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      onStarted();
      yield* events;
    },
  };
  const eventStream = Stream.fromAsyncIterable(startedEvents, (cause) => cause);
  return Stream.runForEachWhile(eventStream, (event) =>
    Effect.sync(() => {
      const parsed = parseOpenCodeEvent(event, sessionID);
      if (parsed === undefined) {
        reportDiagnostic("ignored malformed OpenCode event");
        return true;
      }
      if (parsed.interaction) {
        interaction = true;
        return false;
      }
      const observation = parsed.observation;
      if (observation !== undefined) {
        dispatcher.observation(observation);
        return true;
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
      return true;
    }),
  ).pipe(
    Effect.flatMap(() =>
      !interaction && !signal.aborted
        ? Effect.fail(
            new OpenCodeExecutorError(
              "interaction monitor closed before task completion",
            ),
          )
        : Effect.succeed(interaction),
    ),
  );
}

function dispatchMessageObservations(
  value: unknown,
  sessionID: string,
  dispatcher: AttemptTransitionDispatcher,
  excludedMessageIDs: ReadonlySet<string> | undefined,
  onDiagnostic: (message: string) => void,
): readonly string[] {
  const parsed = parseOpenCodeMessageObservations(value, sessionID);
  if (parsed.malformedPartCount > 0) {
    onDiagnostic(
      `ignored ${parsed.malformedPartCount} malformed OpenCode tool message part(s)`,
    );
  }
  for (const observation of parsed.observations) {
    if (excludedMessageIDs?.has(observation.messageID)) continue;
    dispatcher.observation(observation);
  }
  return parsed.messageIDs;
}

function addMessageIDs(
  history: PromptMessageHistoryState,
  messageIDs: readonly string[],
): void {
  for (const messageID of messageIDs) {
    history.knownMessageIDs.add(messageID);
  }
}

async function snapshotPromptMessageHistory(
  transport: OpenCodeTransport,
  sessionID: string,
  signal: AbortSignal,
  history: PromptMessageHistoryState,
  onDiagnostic: (message: string) => void,
): Promise<void> {
  if (history.ready || transport.listMessages === undefined) return;
  try {
    await dispatchMessageHistory(
      transport,
      sessionID,
      signal,
      history,
      undefined,
      onDiagnostic,
    );
    history.ready = true;
  } catch {
    onDiagnostic("could not snapshot the OpenCode session messages");
  }
}

async function dispatchMessageHistory(
  transport: OpenCodeTransport,
  sessionID: string,
  signal: AbortSignal,
  history: PromptMessageHistoryState,
  dispatcher: AttemptTransitionDispatcher | undefined,
  onDiagnostic: (message: string) => void,
): Promise<void> {
  if (transport.listMessages === undefined) return;
  const baseline = !history.ready;
  let cursor = baseline ? history.cursor : undefined;
  for (let pageIndex = 0; pageIndex < maxMessageHistoryPages; pageIndex += 1) {
    const page = await transport.listMessages(sessionID, signal, {
      order: baseline ? "asc" : "desc",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const parsed = parseOpenCodeMessageObservations(page.messages, sessionID);
    if (parsed.malformedPartCount > 0) {
      onDiagnostic(
        `ignored ${parsed.malformedPartCount} malformed OpenCode tool message part(s)`,
      );
    }
    if (dispatcher !== undefined) {
      for (const observation of parsed.observations) {
        if (baseline || !history.knownMessageIDs.has(observation.messageID)) {
          dispatcher.observation(observation);
        }
      }
    }
    addMessageIDs(history, parsed.messageIDs);
    if (!baseline || page.nextCursor === undefined) {
      history.cursor = undefined;
      history.ready = true;
      return;
    }
    cursor = page.nextCursor;
    history.cursor = cursor;
  }
  onDiagnostic(
    `stopped OpenCode message history reconciliation after ${maxMessageHistoryPages} pages`,
  );
  history.cursor = undefined;
  history.ready = true;
}

async function reconcilePromptObservations({
  transport,
  sessionID,
  signal,
  response,
  dispatcher,
  history,
  onDiagnostic,
}: ReconcilePromptObservationsInput): Promise<void> {
  const promptMessageIDs = dispatchMessageObservations(
    [response],
    sessionID,
    dispatcher,
    undefined,
    onDiagnostic,
  );
  if (transport.listMessages !== undefined) {
    try {
      await dispatchMessageHistory(
        transport,
        sessionID,
        signal,
        history,
        dispatcher,
        onDiagnostic,
      );
    } catch {
      onDiagnostic(
        "could not read OpenCode session messages for activity observations",
      );
    }
  }
  addMessageIDs(history, promptMessageIDs);
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
      const cleanup = (async () => {
        const [cancelled, drained] = await Promise.allSettled([
          cancel(),
          queue(),
        ]);
        if (cancelled.status === "rejected") throw cancelled.reason;
        if (drained.status === "rejected") throw drained.reason;
      })();
      closePromise = awaitOwnedCleanup(
        cleanup,
        "session cleanup did not terminate before its deadline",
      );
      return closePromise;
    },
  };
}

interface PromptMessageHistoryState {
  ready: boolean;
  readonly knownMessageIDs: Set<string>;
  cursor?: string;
}

interface ReconcilePromptObservationsInput {
  readonly transport: OpenCodeTransport;
  readonly sessionID: string;
  readonly signal: AbortSignal;
  readonly response: unknown;
  readonly dispatcher: AttemptTransitionDispatcher;
  readonly history: PromptMessageHistoryState;
  readonly onDiagnostic: (message: string) => void;
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

  const transport = createOpenCodeTransport(
    connection.url,
    connection.authorization,
  );
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

  const promptSemaphore = Effect.runSync(Semaphore.make(1));
  let aborted = false;
  const runController = new AbortController();
  let activeDispatcher: AttemptTransitionDispatcher | undefined;
  const closer = createRunCloser(
    () =>
      Effect.runPromise(Semaphore.withPermits(promptSemaphore, 1)(Effect.void)),
    async () => {
      runController.abort();
      await abort();
      activeDispatcher?.finish();
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
      try {
        callback?.(message);
      } catch {
        // Diagnostics are best effort and must not affect execution.
      }
      return;
    }
    if (eventDiagnosticSuppressionReported) return;
    eventDiagnosticSuppressionReported = true;
    try {
      callback?.(
        "suppressed additional malformed or unsupported OpenCode event diagnostics",
      );
    } catch {
      // Diagnostics are best effort and must not affect execution.
    }
  };
  const messageHistory: PromptMessageHistoryState = {
    ready: false,
    knownMessageIDs: new Set(),
  };

  const prompt = (request: OpenCodePrompt): Promise<OpenCodePromptResult> => {
    const operation = Effect.runPromise(
      Semaphore.withPermits(
        promptSemaphore,
        1,
      )(
        Effect.tryPromise({
          try: async () => {
            closer.assertOpen();
            if (aborted || signal?.aborted || request.signal?.aborted) {
              throw executorError("run was cancelled before task submission");
            }

            try {
              const selected = await outputState.resolve();
              const effectiveStrategy = request.strategy ?? selected.strategy;
              async function abortPromptSession(
                originalFailure?: unknown,
              ): Promise<void> {
                const hasOriginalFailure = arguments.length > 0;
                try {
                  await abort();
                } catch (cause) {
                  request.onUncertainActivity?.({
                    reason: "timeout",
                    termination: abortPromise,
                  });
                  throw executorError(
                    "external session termination was not confirmed",
                    hasOriginalFailure
                      ? new AggregateError([originalFailure, cause])
                      : cause,
                  );
                }
                try {
                  activeDispatcher?.finish();
                } catch (cause) {
                  throw executorError(
                    "canonical event sink failed during prompt cleanup",
                    new AggregateError(
                      hasOriginalFailure ? [originalFailure, cause] : [cause],
                    ),
                  );
                }
              }
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
              const dispatcher = createAttemptTransitionDispatcher({
                onActivity: request.onActivity,
                onObservation: request.onObservation,
              });
              activeDispatcher = dispatcher;
              let monitoredResult: MonitoredPromptResult<OpenCodePromptResult>;
              try {
                monitoredResult = await runMonitoredPrompt({
                  transport,
                  sessionID,
                  runSignal: runController.signal,
                  requestSignal: request.signal,
                  onUncertainActivity: request.onUncertainActivity,
                  abortSession: abortPromptSession,
                  observeEvents: (events, monitorSignal, onStarted) =>
                    waitForInteraction(
                      events,
                      sessionID,
                      monitorSignal,
                      dispatcher,
                      request.onUncertainActivity,
                      (message) =>
                        reportEventDiagnostic(request.onDiagnostic, message),
                      onStarted,
                    ),
                  beforePrompt: async () => {
                    if (
                      effectiveStrategy === "prompt" &&
                      (request.onActivity !== undefined ||
                        request.onObservation !== undefined)
                    ) {
                      await snapshotPromptMessageHistory(
                        transport,
                        sessionID,
                        request.signal ?? runController.signal,
                        messageHistory,
                        (message) =>
                          reportEventDiagnostic(request.onDiagnostic, message),
                      );
                    }
                    request.onExecutionStarted?.();
                  },
                  prompt: async (promptSignal) => {
                    const response = await transport.prompt(
                      sessionID,
                      effectiveRequest,
                      promptSignal,
                    );
                    request.onNativeResponse?.(response);
                    return response;
                  },
                  handleResponse: async (response) => {
                    const parsed = parseOpenCodePromptResponse(
                      response,
                      effectiveStrategy,
                    );
                    if (parsed.checkpoint.sessionId !== sessionID) {
                      throw executorError(
                        "prompt response belonged to another session",
                      );
                    }
                    if (effectiveStrategy === "prompt") {
                      await reconcilePromptObservations({
                        transport,
                        sessionID,
                        signal: request.signal ?? runController.signal,
                        response,
                        dispatcher,
                        history: messageHistory,
                        onDiagnostic: (message) =>
                          reportEventDiagnostic(request.onDiagnostic, message),
                      });
                    } else {
                      dispatchMessageObservations(
                        [response],
                        sessionID,
                        dispatcher,
                        undefined,
                        (message) =>
                          reportEventDiagnostic(request.onDiagnostic, message),
                      );
                    }
                    if (
                      effectiveStrategy === "native" &&
                      transport.listMessages
                    ) {
                      try {
                        await transport.listMessages(
                          sessionID,
                          request.signal ?? runController.signal,
                        );
                      } catch (cause) {
                        if (isNativeReadbackCompatibilityError(cause)) {
                          outputState.markNativeReadbackIncompatible(
                            selected.version,
                          );
                          throw new StructuredOutputCompatibilityError(
                            selected.version,
                            sessionID,
                            cause,
                          );
                        }
                        throw executorError(
                          "could not read the external session",
                          cause,
                        );
                      }
                    }
                    terminalCheckpoint = parsed.checkpoint;
                    return {
                      structured: parsed.structured,
                      ...(parsed.text === undefined
                        ? {}
                        : { text: parsed.text }),
                      nativeResponse: response,
                      ...(parsed.metrics === undefined
                        ? {}
                        : { metrics: parsed.metrics }),
                      ...(parsed.observation === undefined
                        ? {}
                        : { observation: parsed.observation }),
                    };
                  },
                });
              } finally {
                if (activeDispatcher === dispatcher)
                  activeDispatcher = undefined;
              }

              if (monitoredResult.type === "cancelled") {
                dispatcher.finish();
                throw executorError("run was cancelled during task submission");
              }
              if (monitoredResult.type === "monitor-error") {
                request.onRunInvalidated?.();
                try {
                  dispatcher.finish();
                } catch (terminalCause) {
                  throw executorError(
                    "canonical event sink failed during prompt cleanup",
                    new AggregateError(
                      [monitoredResult.cause, terminalCause],
                      "OpenCode monitor and terminal event sinks failed",
                    ),
                  );
                }
                throw executorError(
                  "could not monitor external interaction requirements",
                  monitoredResult.cause,
                );
              }
              if (monitoredResult.type === "interaction") {
                request.onRunInvalidated?.();
                dispatcher.finish();
                throw new InteractionRequiredError("user-input");
              }
              if (monitoredResult.type === "transport-error") {
                if (
                  effectiveStrategy === "native" &&
                  isNativeReadbackCompatibilityError(monitoredResult.cause)
                ) {
                  outputState.markNativeReadbackIncompatible(selected.version);
                  throw new StructuredOutputCompatibilityError(
                    selected.version,
                    sessionID,
                    monitoredResult.cause,
                  );
                }
                request.onUncertainActivity?.({ reason: "disconnect" });
                throw executorError(
                  "structured task request failed",
                  monitoredResult.cause,
                );
              }
              return monitoredResult.response;
            } catch (cause) {
              if (cause instanceof InteractionRequiredError) throw cause;
              if (
                cause instanceof OpenCodeExecutorError ||
                cause instanceof StructuredOutputCompatibilityError
              )
                throw cause;
              throw executorError("structured task request failed", cause);
            }
          },
          catch: (cause) => cause,
        }),
      ),
    );
    void operation.catch(() => undefined);
    return operation;
  };

  const abort = (): Promise<void> => {
    if (abortPromise) return abortPromise;
    aborted = true;
    const abortOperation = transport
      .abort(sessionID, AbortSignal.timeout(runAbortTimeoutMs))
      .then(() => undefined)
      .catch((cause) => {
        throw executorError("could not abort the external session", cause);
      });
    abortPromise = awaitOwnedCleanup(
      abortOperation,
      "external session abort did not terminate before its deadline",
    );
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
