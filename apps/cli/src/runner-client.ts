import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  decodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import {
  decodeRuntimeSessionUiAvailable,
  type RuntimeSessionUiAvailable,
} from "@seqlane/runtime";
import { encodeRunnerCommand, type RunRequest } from "@seqlane/protocol";

export type TerminalSeqlaneExecutionEvent = Extract<
  SeqlaneExecutionEvent,
  { readonly type: "run.succeeded" | "run.failed" | "run.cancelled" }
>;

type TerminalEvent = TerminalSeqlaneExecutionEvent;
type RunnerMessage = SeqlaneExecutionEvent | RuntimeSessionUiAvailable;

export type RunnerExitStatus = 0 | 1 | 130;

export interface RunnerFailure {
  readonly type: "runner.failure";
  readonly message: string;
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
    }
  | {
      readonly status: 130;
      readonly failure: RunnerFailure;
    }
  | {
      readonly status: 1;
      readonly failure: RunnerFailure;
    };

export interface RunnerChild {
  on(event: "message", listener: (message: unknown) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  send(message: string, callback?: (error: Error | null) => void): boolean;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface RunnerSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): this;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): this;
}

export interface RunnerTimer {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RunnerSupervisionOptions {
  readonly onExecutionEvent?: (event: SeqlaneExecutionEvent) => void;
  readonly onRuntimeSessionUiAvailable?: (
    notification: RuntimeSessionUiAvailable,
  ) => void;
  readonly onProtocolError?: (error: unknown) => void;
  readonly signalSource?: RunnerSignalSource | null;
  readonly gracePeriodMs?: number;
  readonly timer?: RunnerTimer;
}

export interface RunnerClientOptions extends RunnerSupervisionOptions {
  readonly runnerPath?: string;
  readonly cwd?: string;
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

function terminalResult(event: TerminalEvent): RunnerSupervisionResult {
  switch (event.type) {
    case "run.succeeded":
      return { status: 0, terminalEvent: event };
    case "run.failed":
      return { status: 1, terminalEvent: event };
    case "run.cancelled":
      return { status: 130, terminalEvent: event };
  }
}

function failure(message: string): RunnerSupervisionResult {
  return { status: 1, failure: { type: "runner.failure", message } };
}

function cancellationFailure(message: string): RunnerSupervisionResult {
  return { status: 130, failure: { type: "runner.failure", message } };
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

const defaultGracePeriodMs = 5_000;
const runnerModuleSpecifier = "seqlane/runner";

const defaultTimer: RunnerTimer = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function decodeRunnerMessage(message: unknown): RunnerMessage {
  if (typeof message !== "string") {
    throw new TypeError("Invalid runner message");
  }

  try {
    return decodeRuntimeSessionUiAvailable(message);
  } catch {
    return decodeSeqlaneExecutionEvent(message);
  }
}

export function createRunnerSupervision(
  child: RunnerChild,
  request: RunRequest,
  options: RunnerSupervisionOptions = {},
): RunnerSupervision {
  const encodedRequest = encodeRunnerCommand(request);
  const encodedCancel = encodeRunnerCommand({ type: "run.cancel" });
  const signalSource =
    options.signalSource === null
      ? undefined
      : (options.signalSource ?? (process as unknown as RunnerSignalSource));
  const timer = options.timer ?? defaultTimer;
  const gracePeriodMs = Math.max(
    0,
    options.gracePeriodMs ?? defaultGracePeriodMs,
  );

  let cancelRun = (): void => undefined;
  const result = new Promise<RunnerSupervisionResult>((resolve) => {
    let terminalEvent: TerminalEvent | undefined;
    let settled = false;
    let cancellationRequested = false;
    let graceTimer: unknown;

    const cleanup = () => {
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (signalSource !== undefined) {
        signalSource.removeListener("SIGINT", onSignal);
        signalSource.removeListener("SIGTERM", onSignal);
      }
      if (graceTimer !== undefined) timer.clearTimeout(graceTimer);
    };

    const finish = (result: RunnerSupervisionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const reportProtocolError = (error: unknown) => {
      try {
        options.onProtocolError?.(error);
      } catch {
        // Callback failures must not prevent the supervisor from reporting status.
      }
    };

    const onError = (error: Error) => {
      if (terminalEvent !== undefined) return;
      reportProtocolError(error);
      if (cancellationRequested) {
        finish(
          cancellationFailure(
            `Runner process error during cancellation: ${errorMessage(error)}`,
          ),
        );
      } else {
        finish(failure(`Runner process error: ${errorMessage(error)}`));
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminalEvent !== undefined) return;
      if (cancellationRequested) {
        finish(
          cancellationFailure(
            `Runner exited during cancellation before reporting run.cancelled`,
          ),
        );
      } else {
        finish(childExitFailure(code, signal));
      }
    };

    const onSignal = (): void => cancelRun();

    cancelRun = () => {
      if (settled || terminalEvent !== undefined || cancellationRequested) {
        return;
      }
      cancellationRequested = true;

      const onCancelSendError = (error: Error | null) => {
        if (error !== null) reportProtocolError(error);
      };

      try {
        child.send(encodedCancel, onCancelSendError);
      } catch (error) {
        reportProtocolError(error);
      }

      graceTimer = timer.setTimeout(() => {
        if (settled || terminalEvent !== undefined) return;
        try {
          child.kill?.("SIGTERM");
        } catch (error) {
          reportProtocolError(error);
        } finally {
          finish(
            cancellationFailure(
              `Graceful cancellation timed out after ${gracePeriodMs}ms`,
            ),
          );
        }
      }, gracePeriodMs);
    };

    const onMessage = (message: unknown) => {
      let runnerMessage: RunnerMessage;
      try {
        runnerMessage = decodeRunnerMessage(message);
      } catch (error) {
        reportProtocolError(error);
        finish(failure(errorMessage(error)));
        return;
      }

      if (runnerMessage.type === "runtime.session.ui-available") {
        try {
          options.onRuntimeSessionUiAvailable?.(runnerMessage);
        } catch (error) {
          reportProtocolError(error);
        }
        return;
      }

      const event = runnerMessage;

      if (terminalEvent !== undefined) {
        const protocolError = new Error(
          "Received duplicate terminal runner event",
        );
        reportProtocolError(protocolError);
        finish(failure(protocolError.message));
        return;
      }

      options.onExecutionEvent?.(event);

      if (
        event.type !== "run.succeeded" &&
        event.type !== "run.failed" &&
        event.type !== "run.cancelled"
      ) {
        return;
      }

      terminalEvent = event as TerminalEvent;
      // Give already-queued IPC messages (including a duplicate terminal event)
      // one turn to be validated, without waiting for child exit.
      setImmediate(() => {
        if (terminalEvent !== undefined) {
          finish(terminalResult(terminalEvent));
        }
      });
    };

    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
    signalSource?.on("SIGINT", onSignal);
    signalSource?.on("SIGTERM", onSignal);

    try {
      child.send(encodedRequest, (error) => {
        if (error !== null) onError(error);
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  });

  return { result, cancel: () => cancelRun() };
}

export function superviseRunner(
  child: RunnerChild,
  request: RunRequest,
  options: RunnerSupervisionOptions = {},
): Promise<RunnerSupervisionResult> {
  return createRunnerSupervision(child, request, options).result;
}

function defaultRunnerPath(): string {
  return createRequire(import.meta.url).resolve(runnerModuleSpecifier);
}

export function launchRunner(
  request: RunRequest,
  options: RunnerClientOptions = {},
): RunnerClient {
  const child = fork(options.runnerPath ?? defaultRunnerPath(), [], {
    cwd: options.cwd,
    // Keep terminal signals at the supervising CLI. It delivers a structured
    // run.cancel command and waits for OpenCode to acknowledge /abort.
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const supervision = createRunnerSupervision(
    child as unknown as RunnerChild,
    request,
    options,
  );

  return {
    child,
    request,
    result: supervision.result,
    cancel: supervision.cancel,
    close: () => {
      if (!child.killed) child.kill();
    },
  };
}
