import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { Clock, Duration, Effect } from "effect";
import {
  decodeSeqlaneExecutionEvent,
  encodeRunnerCommand,
  type RunRequest,
  type RespondToInteraction,
  type InteractionRequestedEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import {
  decodeRuntimeSessionUiAvailable,
  type RuntimeSessionUiAvailable,
} from "@seqlane/runtime";
import {
  decodeTelemetrySpanSnapshotFrame,
  isTelemetrySpanSnapshotFrameCandidate,
  type TelemetrySpanSnapshotFrame,
} from "@seqlane/protocol/private/telemetry-span-snapshot";
import {
  decodeOwnedProcessFrame,
  isOwnedProcessFrameCandidate,
  type OwnedProcessFrame,
} from "@seqlane/protocol/private/owned-process";
import { createOwnedProcessSupervision } from "./owned-process-supervision.js";
import { createRunnerInbox } from "./runner-inbox.js";

export type TerminalSeqlaneExecutionEvent = Extract<
  SeqlaneExecutionEvent,
  { readonly type: "run.succeeded" | "run.failed" | "run.cancelled" }
>;

type TerminalEvent = TerminalSeqlaneExecutionEvent;
type RunnerMessage =
  | SeqlaneExecutionEvent
  | RuntimeSessionUiAvailable
  | TelemetrySpanSnapshotFrame;

export type RunnerExitStatus = 0 | 1 | 130;
export type RunnerCancellationSignal = "SIGINT" | "SIGTERM";

export interface RunnerFailure {
  readonly type: "runner.failure";
  readonly message: string;
  /** Original internal cause; omitted from serialized CLI output. */
  readonly cause?: unknown;
}

export type RunnerSupervisionResult =
  | {
      readonly status: 0;
      readonly terminalEvent: Extract<
        TerminalEvent,
        { readonly type: "run.succeeded" }
      >;
    }
  | {
      readonly status: 1;
      readonly terminalEvent: Extract<
        TerminalEvent,
        { readonly type: "run.failed" }
      >;
    }
  | {
      readonly status: 130;
      readonly terminalEvent: Extract<
        TerminalEvent,
        { readonly type: "run.cancelled" }
      >;
      readonly cancellationSignal?: RunnerCancellationSignal;
    }
  | {
      readonly status: 130;
      readonly failure: RunnerFailure;
      readonly cancellationSignal?: RunnerCancellationSignal;
    }
  | {
      readonly status: 1;
      readonly failure: RunnerFailure;
    };

export interface RunnerChild {
  on(event: "message", listener: (message: unknown) => void): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "disconnect", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  removeListener(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: "disconnect", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  send(message: string, callback?: (error: Error | null) => void): boolean;
  kill?(signal?: NodeJS.Signals): boolean;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface RunnerSignalSource {
  on(signal: RunnerCancellationSignal, listener: () => void): this;
  removeListener(signal: RunnerCancellationSignal, listener: () => void): this;
}

export interface RunnerSupervisionOptions {
  readonly onReady?: (cancelRun: () => void) => void;
  readonly onExecutionEvent?: (event: SeqlaneExecutionEvent) => void;
  readonly onInteractionRequested?: (
    event: InteractionRequestedEvent,
    respond: (command: RespondToInteraction) => Promise<void>,
    cancelRun: () => void,
  ) => void | Promise<void>;
  readonly onTelemetrySpans?: (frame: TelemetrySpanSnapshotFrame) => void;
  readonly onTelemetryDiagnostic?: () => void;
  readonly onRuntimeSessionUiAvailable?: (
    notification: RuntimeSessionUiAvailable,
  ) => void;
  readonly onProtocolError?: (error: unknown) => void;
  readonly signalSource?: RunnerSignalSource | null;
  readonly gracePeriodMs?: number;
  readonly closeGracePeriodMs?: number;
}

export interface RunnerClientOptions extends RunnerSupervisionOptions {
  readonly runnerPath?: string;
  readonly cwd?: string;
  /** Private environment values set by the CLI for its owned worker. */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface RunnerClient {
  readonly child: ChildProcess;
  readonly request: RunRequest;
  readonly result: Promise<RunnerSupervisionResult>;
  cancel(): void;
  close(): void;
}

export interface RunnerSupervision {
  readonly result: Promise<RunnerSupervisionResult>;
  cancel(): void;
}

export function mapRunnerOutcomeToStatus(
  event: TerminalEvent,
): RunnerExitStatus {
  switch (event.type) {
    case "run.succeeded":
      return 0;
    case "run.failed":
      return 1;
    case "run.cancelled":
      return 130;
  }
}

function terminalResult(
  event: TerminalEvent,
  cancellationSignal?: RunnerCancellationSignal,
): RunnerSupervisionResult {
  switch (event.type) {
    case "run.succeeded":
      return { status: 0, terminalEvent: event };
    case "run.failed":
      return { status: 1, terminalEvent: event };
    case "run.cancelled":
      return {
        status: 130,
        terminalEvent: event,
        ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
      };
  }
}

function failure(message: string, cause?: unknown): RunnerSupervisionResult {
  const runnerFailure: RunnerFailure = { type: "runner.failure", message };
  if (arguments.length > 1) {
    Object.defineProperty(runnerFailure, "cause", { value: cause });
  }
  return {
    status: 1,
    failure: runnerFailure,
  };
}

function cancellationFailure(
  message: string,
  cancellationSignal?: RunnerCancellationSignal,
  cause?: unknown,
): RunnerSupervisionResult {
  const runnerFailure: RunnerFailure = { type: "runner.failure", message };
  if (arguments.length > 2) {
    Object.defineProperty(runnerFailure, "cause", { value: cause });
  }
  return {
    status: 130,
    failure: runnerFailure,
    ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childExitFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
): RunnerSupervisionResult {
  const detail = signal === null ? `code ${code}` : `signal ${signal}`;
  return failure(
    `Runner exited with ${detail} before reporting a terminal event`,
  );
}

const defaultGracePeriodMs = 35_000;
const defaultCloseGracePeriodMs = 5_000;
const runnerModuleSpecifier = "seqlane/runner";
function decodeRunnerMessage(message: unknown): RunnerMessage {
  if (typeof message !== "string")
    throw new TypeError("Invalid runner message");
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    // The protocol decoders provide the malformed-frame error.
  }
  if (isOwnedProcessFrameCandidate(parsed)) {
    throw new TypeError("Invalid owned process frame");
  }
  try {
    return decodeTelemetrySpanSnapshotFrame(message);
  } catch {
    // The private telemetry frame is a separate validated IPC contract.
  }
  try {
    return decodeRuntimeSessionUiAvailable(message);
  } catch {
    return decodeSeqlaneExecutionEvent(message);
  }
}

type SupervisionMessage =
  | {
      readonly type: "runner-message";
      readonly value: string;
      readonly utf8Bytes: number;
    }
  | { readonly type: "invalid-runner-message" }
  | {
      readonly type: "close";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: "disconnect" }
  | { readonly type: "error"; readonly error: Error }
  | { readonly type: "user-cancel" }
  | { readonly type: "signal"; readonly signal: RunnerCancellationSignal }
  | { readonly type: "request-send-error"; readonly error: Error }
  | { readonly type: "cancel-send-error"; readonly error: Error }
  | {
      readonly type: "owned-process";
      readonly frame: OwnedProcessFrame;
      readonly utf8Bytes: number;
    }
  | { readonly type: "fallback-timeout" }
  | { readonly type: "close-timeout" };

/** Effect owns worker supervision, bounded waiting, cancellation, and listeners. */
export function superviseRunnerEffect(
  child: RunnerChild,
  request: RunRequest,
  options: RunnerSupervisionOptions = {},
): Effect.Effect<RunnerSupervisionResult, unknown> {
  const encodedRequest = encodeRunnerCommand(request);
  const encodedCancel = encodeRunnerCommand({ type: "run.cancel" });
  const signalSource =
    options.signalSource === null
      ? undefined
      : (options.signalSource ?? processSignalSource);
  const gracePeriodMs = Math.max(
    0,
    options.gracePeriodMs ?? defaultGracePeriodMs,
  );
  const closeGracePeriodMs = Math.max(
    0,
    options.closeGracePeriodMs ?? defaultCloseGracePeriodMs,
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const inbox = yield* createRunnerInbox<SupervisionMessage>();
      let pendingSignal: RunnerCancellationSignal | undefined;
      let closeNotification:
        Extract<SupervisionMessage, { readonly type: "close" }> | undefined;
      const offer = (message: SupervisionMessage): void => {
        inbox.offer(message);
      };
      const offerRunnerMessage = (
        message: Extract<SupervisionMessage, { readonly utf8Bytes: number }>,
      ): void => {
        inbox.offerRunnerMessage(message);
      };
      let terminalEvent: TerminalEvent | undefined;
      let cancellationSignal: RunnerCancellationSignal | undefined;
      let userCancellationRequested = false;
      let cancellationRequested = false;
      let failureResult: RunnerSupervisionResult | undefined;
      let closed = false;
      let disconnectObserved = false;
      let workerExitObserved = false;
      let workerExitCode: number | null = null;
      let workerExitSignal: NodeJS.Signals | null = null;
      let closeCode: number | null = null;
      let closeSignal: NodeJS.Signals | null = null;
      let fallbackStarted = false;
      let signalCount = 0;
      let fallbackDeadlineNanos: bigint | undefined;
      let terminalCloseDeadlineNanos: bigint | undefined;
      let workerCloseDeadlineNanos: bigint | undefined;
      let workerKillSent = false;

      const onMessage = (message: unknown): void => {
        if (typeof message !== "string") {
          offer({ type: "invalid-runner-message" });
          return;
        }
        const utf8Bytes = Buffer.byteLength(message, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          parsed = undefined;
        }
        if (isOwnedProcessFrameCandidate(parsed)) {
          try {
            offerRunnerMessage({
              type: "owned-process",
              frame: decodeOwnedProcessFrame(message),
              utf8Bytes,
            });
          } catch {
            offerRunnerMessage({
              type: "runner-message",
              value: message,
              utf8Bytes,
            });
          }
          return;
        }
        offerRunnerMessage({
          type: "runner-message",
          value: message,
          utf8Bytes,
        });
      };
      const onClose = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        closeNotification = { type: "close", code, signal };
        offer(closeNotification);
      };
      const onExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): void => offer({ type: "exit", code, signal });
      const onDisconnect = (): void => offer({ type: "disconnect" });
      const onError = (error: Error): void => offer({ type: "error", error });
      const onSigint = (): void => {
        signalCount += 1;
        pendingSignal ??= "SIGINT";
        offer({ type: "signal", signal: "SIGINT" });
      };
      const onSigterm = (): void => {
        signalCount += 1;
        pendingSignal ??= "SIGTERM";
        offer({ type: "signal", signal: "SIGTERM" });
      };

      child.on("message", onMessage);
      child.on("close", onClose);
      child.on("exit", onExit);
      child.on("disconnect", onDisconnect);
      child.on("error", onError);
      signalSource?.on("SIGINT", onSigint);
      signalSource?.on("SIGTERM", onSigterm);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          child.removeListener("message", onMessage);
          child.removeListener("close", onClose);
          child.removeListener("exit", onExit);
          child.removeListener("disconnect", onDisconnect);
          child.removeListener("error", onError);
          signalSource?.removeListener("SIGINT", onSigint);
          signalSource?.removeListener("SIGTERM", onSigterm);
        }),
      );

      const reportProtocolError = (error: unknown): void => {
        try {
          options.onProtocolError?.(error);
        } catch {
          // Diagnostics cannot prevent process cleanup.
        }
      };
      const ownedProcessSupervision = createOwnedProcessSupervision(
        child,
        reportProtocolError,
      );

      const sendCancel = (): void => {
        if (cancellationRequested) return;
        cancellationRequested = true;
        try {
          child.send(encodedCancel, (error) => {
            if (error !== null) offer({ type: "cancel-send-error", error });
          });
        } catch (error) {
          offer({
            type: "cancel-send-error",
            error:
              error instanceof Error ? error : new Error(errorMessage(error)),
          });
        }
      };

      const respondToInteraction = (
        command: RespondToInteraction,
      ): Promise<void> => {
        const encoded = encodeRunnerCommand(command);
        return new Promise((resolve, reject) => {
          try {
            child.send(encoded, (error) =>
              error === null ? resolve() : reject(error),
            );
          } catch (cause) {
            reject(cause);
          }
        });
      };

      const startFallback = (): void => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        sendCancel();
      };
      const cancelRun = (): void => {
        offer({ type: "user-cancel" });
      };
      const isCancellationRequested = (): boolean =>
        cancellationSignal !== undefined || userCancellationRequested;

      const workerClosed = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) =>
        Effect.gen(function* () {
          closeNotification = undefined;
          closed = true;
          closeCode = code;
          closeSignal = signal;
          if (ownedProcessSupervision.size > 0) {
            yield* ownedProcessSupervision.cleanup();
            const error = new Error(
              "Runner closed before releasing all owned processes",
            );
            reportProtocolError(error);
            failureResult ??= isCancellationRequested()
              ? cancellationFailure(error.message, cancellationSignal, error)
              : failure(error.message, error);
          }
        });

      try {
        options.onReady?.(cancelRun);
        child.send(encodedRequest, (error) => {
          if (error !== null) offer({ type: "request-send-error", error });
        });
      } catch (error) {
        offer({
          type: "request-send-error",
          error:
            error instanceof Error ? error : new Error(errorMessage(error)),
        });
      }

      while (true) {
        let message: SupervisionMessage;
        if (pendingSignal !== undefined && !fallbackStarted) {
          cancellationSignal ??= pendingSignal;
          startFallback();
        }
        if (inbox.overflowed) {
          inbox.clearOverflow();
          const error = new Error("Runner supervisor message queue overflowed");
          reportProtocolError(error);
          failureResult ??= cancellationSignal
            ? cancellationFailure(error.message, cancellationSignal, error)
            : failure(error.message, error);
          startFallback();
        }
        if (fallbackStarted && fallbackDeadlineNanos === undefined) {
          fallbackDeadlineNanos =
            (yield* Clock.monotonicTimeNanos) +
            BigInt(gracePeriodMs) * 1_000_000n;
        }
        if (
          terminalEvent !== undefined &&
          terminalCloseDeadlineNanos === undefined
        ) {
          terminalCloseDeadlineNanos =
            (yield* Clock.monotonicTimeNanos) +
            BigInt(closeGracePeriodMs) * 1_000_000n;
        }
        if (closed && failureResult !== undefined) {
          return failureResult;
        } else if (closed && terminalEvent !== undefined) {
          return terminalResult(terminalEvent, cancellationSignal);
        } else if (closed) {
          return isCancellationRequested()
            ? cancellationFailure(
                "Runner closed during cancellation before reporting run.cancelled",
                cancellationSignal,
              )
            : childExitFailure(closeCode, closeSignal);
        }

        const now = yield* Clock.monotonicTimeNanos;
        if (workerKillSent && now >= (workerCloseDeadlineNanos ?? now)) {
          message = { type: "close-timeout" };
        } else if (
          !workerKillSent &&
          fallbackStarted &&
          now >= (fallbackDeadlineNanos ?? now)
        ) {
          message = { type: "fallback-timeout" };
        } else if (
          !workerKillSent &&
          !fallbackStarted &&
          terminalEvent !== undefined &&
          now >= (terminalCloseDeadlineNanos ?? now)
        ) {
          message = { type: "close-timeout" };
        } else if (workerKillSent) {
          const deadline = workerCloseDeadlineNanos ?? now;
          message = yield* Effect.raceFirst(
            inbox.take,
            Effect.sleep(Duration.nanos(deadline - now)).pipe(
              Effect.as({ type: "close-timeout" } as const),
            ),
          );
        } else if (fallbackStarted) {
          const deadline = fallbackDeadlineNanos ?? now;
          message = yield* Effect.raceFirst(
            inbox.take,
            Effect.sleep(Duration.nanos(deadline - now)).pipe(
              Effect.as({ type: "fallback-timeout" } as const),
            ),
          );
        } else if (terminalEvent !== undefined) {
          const deadline = terminalCloseDeadlineNanos ?? now;
          message = yield* Effect.raceFirst(
            inbox.take,
            Effect.sleep(Duration.nanos(deadline - now)).pipe(
              Effect.as({ type: "close-timeout" } as const),
            ),
          );
        } else {
          message = yield* inbox.take;
        }

        try {
          switch (message.type) {
            case "invalid-runner-message": {
              const error = new TypeError("Invalid runner message");
              reportProtocolError(error);
              failureResult ??= isCancellationRequested()
                ? cancellationFailure(error.message, cancellationSignal, error)
                : failure(error.message, error);
              startFallback();
              continue;
            }
            case "runner-message": {
              let runnerMessage: RunnerMessage;
              try {
                runnerMessage = decodeRunnerMessage(message.value);
              } catch (error) {
                if (isTelemetrySpanSnapshotFrameCandidate(message.value)) {
                  try {
                    options.onTelemetryDiagnostic?.();
                  } catch {
                    // Optional telemetry remains diagnostic only.
                  }
                  continue;
                }
                reportProtocolError(error);
                failureResult ??= isCancellationRequested()
                  ? cancellationFailure(
                      errorMessage(error),
                      cancellationSignal,
                      error,
                    )
                  : failure(errorMessage(error), error);
                startFallback();
                continue;
              }
              if (runnerMessage.type === "runtime.session.ui-available") {
                try {
                  options.onRuntimeSessionUiAvailable?.(runnerMessage);
                } catch (error) {
                  reportProtocolError(error);
                }
                continue;
              }
              if (runnerMessage.type === "runner.telemetry.spans") {
                try {
                  options.onTelemetrySpans?.(runnerMessage);
                } catch (error) {
                  reportProtocolError(error);
                }
                continue;
              }
              const event = runnerMessage;
              if (terminalEvent !== undefined) {
                const error = new Error(
                  "Received duplicate terminal runner event",
                );
                reportProtocolError(error);
                terminalEvent = undefined;
                failureResult ??= isCancellationRequested()
                  ? cancellationFailure(
                      error.message,
                      cancellationSignal,
                      error,
                    )
                  : failure(error.message, error);
                startFallback();
                continue;
              }
              try {
                options.onExecutionEvent?.(event);
                if (event.type === "interaction.requested") {
                  const handled = options.onInteractionRequested?.(
                    event,
                    respondToInteraction,
                    cancelRun,
                  );
                  if (handled instanceof Promise) {
                    void handled.catch((cause: unknown) =>
                      offer({
                        type: "error",
                        error:
                          cause instanceof Error
                            ? cause
                            : new Error(errorMessage(cause)),
                      }),
                    );
                  }
                }
              } catch (error) {
                reportProtocolError(error);
                failureResult ??= isCancellationRequested()
                  ? cancellationFailure(
                      `Runner output failed: ${errorMessage(error)}`,
                      cancellationSignal,
                      error,
                    )
                  : failure(
                      `Runner output failed: ${errorMessage(error)}`,
                      error,
                    );
                startFallback();
                continue;
              }
              if (
                event.type === "run.succeeded" ||
                event.type === "run.failed" ||
                event.type === "run.cancelled"
              ) {
                terminalEvent = event;
              }
              continue;
            }
            case "owned-process": {
              const result = yield* ownedProcessSupervision
                .handle(message.frame)
                .pipe(
                  Effect.match({
                    onFailure: (error) => ({ error }),
                    onSuccess: () => ({ success: true as const }),
                  }),
                );
              if ("error" in result) {
                const error = result.error;
                reportProtocolError(error);
                failureResult ??= isCancellationRequested()
                  ? cancellationFailure(
                      errorMessage(error),
                      cancellationSignal,
                      error,
                    )
                  : failure(errorMessage(error), error);
                startFallback();
              }
              continue;
            }
            case "signal":
              cancellationSignal ??= pendingSignal ?? message.signal;
              startFallback();
              if (signalCount > 1) offer({ type: "fallback-timeout" });
              continue;
            case "user-cancel":
              userCancellationRequested = true;
              startFallback();
              continue;
            case "request-send-error":
              reportProtocolError(message.error);
              failureResult ??= isCancellationRequested()
                ? cancellationFailure(
                    `Runner process error during cancellation: ${errorMessage(message.error)}`,
                    cancellationSignal,
                    message.error,
                  )
                : failure(
                    `Runner process error: ${errorMessage(message.error)}`,
                    message.error,
                  );
              startFallback();
              continue;
            case "cancel-send-error":
              reportProtocolError(message.error);
              continue;
            case "error":
              reportProtocolError(message.error);
              failureResult ??= isCancellationRequested()
                ? cancellationFailure(
                    `Runner process error during cancellation: ${errorMessage(message.error)}`,
                    cancellationSignal,
                    message.error,
                  )
                : failure(
                    `Runner process error: ${errorMessage(message.error)}`,
                    message.error,
                  );
              startFallback();
              continue;
            case "disconnect":
              disconnectObserved = true;
              if (terminalEvent === undefined) {
                const message = isCancellationRequested()
                  ? "Runner disconnected during cancellation before reporting run.cancelled"
                  : "Runner disconnected before reporting a terminal event";
                const error = new Error(message);
                failureResult ??= isCancellationRequested()
                  ? cancellationFailure(message, cancellationSignal, error)
                  : failure(message, error);
                reportProtocolError(error);
                startFallback();
              }
              if (
                workerExitObserved &&
                terminalEvent === undefined &&
                failureResult !== undefined
              ) {
                yield* workerClosed(workerExitCode, workerExitSignal);
              }
              continue;
            case "exit":
              workerExitObserved = true;
              workerExitCode = message.code;
              workerExitSignal = message.signal;
              // An accepted terminal event still waits for `close` so buffered
              // IPC is drained. Without a terminal event, a disconnected IPC
              // channel plus confirmed process exit bounds supervision safely.
              if (
                disconnectObserved &&
                terminalEvent === undefined &&
                failureResult !== undefined
              ) {
                yield* workerClosed(message.code, message.signal);
              }
              continue;
            case "close":
              yield* workerClosed(message.code, message.signal);
              continue;
            case "fallback-timeout": {
              if (workerKillSent) continue;
              reportProtocolError(
                new Error(
                  `Runner cleanup timed out after ${gracePeriodMs}ms; forcing the owned worker to stop`,
                ),
              );
              const ownedCleanupConfirmed =
                yield* ownedProcessSupervision.cleanup();
              if (!ownedCleanupConfirmed && failureResult === undefined) {
                failureResult ??= isCancellationRequested()
                  ? cancellationFailure(
                      "Could not confirm all owned processes stopped during cancellation",
                      cancellationSignal,
                    )
                  : failure("Could not confirm all owned processes stopped");
              }
              workerKillSent = true;
              workerCloseDeadlineNanos =
                (yield* Clock.monotonicTimeNanos) +
                BigInt(closeGracePeriodMs) * 1_000_000n;
              try {
                child.kill?.("SIGKILL");
              } catch (error) {
                reportProtocolError(error);
              }
              continue;
            }
            case "close-timeout":
              if (workerKillSent) {
                reportProtocolError(
                  new Error("Runner did not close after forced cleanup"),
                );
                return isCancellationRequested()
                  ? cancellationFailure(
                      "Runner did not close after forced cleanup",
                      cancellationSignal,
                    )
                  : failure("Runner did not close after forced cleanup");
              }
              reportProtocolError(
                new Error(
                  `Runner reported its terminal event but did not close within ${closeGracePeriodMs}ms`,
                ),
              );
              failureResult ??= isCancellationRequested()
                ? cancellationFailure(
                    "Runner did not close after reporting a terminal event",
                    cancellationSignal,
                  )
                : failure(
                    "Runner did not close after reporting a terminal event",
                  );
              try {
                child.kill?.("SIGTERM");
              } catch (error) {
                reportProtocolError(error);
              }
              startFallback();
              continue;
          }
        } finally {
          inbox.consume(message);
        }
      }
    }),
  );
}

const processSignalSource: RunnerSignalSource = {
  on(signal, listener) {
    process.on(signal, listener);
    return this;
  },
  removeListener(signal, listener) {
    process.removeListener(signal, listener);
    return this;
  },
};

export function superviseRunner(
  child: RunnerChild,
  request: RunRequest,
  options: RunnerSupervisionOptions = {},
): Promise<RunnerSupervisionResult> {
  return Effect.runPromise(superviseRunnerEffect(child, request, options));
}

function createLocalCancellationSource(options: RunnerSupervisionOptions): {
  readonly source: RunnerSignalSource;
  cancel(): void;
} {
  const localSignals = new EventEmitter();
  const externalSignals =
    options.signalSource === null
      ? undefined
      : (options.signalSource ?? processSignalSource);
  const source: RunnerSignalSource = {
    on(signal, listener) {
      localSignals.on(signal, listener);
      externalSignals?.on(signal, listener);
      return this;
    },
    removeListener(signal, listener) {
      localSignals.removeListener(signal, listener);
      externalSignals?.removeListener(signal, listener);
      return this;
    },
  };
  return { source, cancel: () => localSignals.emit("SIGINT") };
}

export function createRunnerSupervision(
  child: RunnerChild,
  request: RunRequest,
  options: RunnerSupervisionOptions = {},
): RunnerSupervision {
  const localCancellation = createLocalCancellationSource(options);
  return {
    result: superviseRunner(child, request, {
      ...options,
      signalSource: localCancellation.source,
    }),
    cancel: localCancellation.cancel,
  };
}

function defaultRunnerPath(): string {
  return createRequire(import.meta.url).resolve(runnerModuleSpecifier);
}

export function spawnRunnerProcess(
  options: Pick<RunnerClientOptions, "runnerPath" | "cwd" | "environment"> = {},
): ChildProcess {
  return fork(options.runnerPath ?? defaultRunnerPath(), [], {
    cwd: options.cwd,
    env: options.environment,
    detached: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

export function launchRunner(
  request: RunRequest,
  options: RunnerClientOptions = {},
): RunnerClient {
  const child = spawnRunnerProcess(options);
  const supervision = createRunnerSupervision(child, request, options);
  return {
    child,
    request,
    result: supervision.result,
    cancel: supervision.cancel,
    close: () => {
      if (child.exitCode === null && child.signalCode === null)
        supervision.cancel();
    },
  };
}
