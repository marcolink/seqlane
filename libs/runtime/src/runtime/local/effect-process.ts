import { Context, Duration, Effect, Layer, Option, Stream } from "effect";
import { ChildProcess } from "effect/process";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { InvocationId, TaskExecResult, TaskId } from "@seqlane/core";
import { z } from "zod";
import { UnconfirmedInvocationTerminationError } from "../execution/executor.js";
import {
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  confirmOwnedProcessStopped,
  terminateOwnedProcess,
} from "../../private/owned-process/index.js";
import type { OwnedProcessIdentity } from "@seqlane/protocol/private/owned-process";

interface LocalProcessResult extends TaskExecResult {
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly outcome: "completed" | "timed_out" | "cancelled";
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export const DEFAULT_LOCAL_PROCESS_TIMEOUT_MS = 30_000;
export const MAX_LOCAL_PROCESS_TIMEOUT_MS = 300_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const outputLimitBytesSchema = z.number().int().nonnegative();
const timeoutMsSchema = z.number().int().positive();

export interface LocalProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly outputLimitBytes: number;
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onOwnedProcessAcquired?: (pid: number) => Promise<void>;
}

interface ProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export class LocalProcessSpawnError extends Error {
  constructor(override readonly cause: unknown) {
    super("Local process could not start", { cause });
    this.name = "LocalProcessSpawnError";
  }
}

export class LocalProcessCancelledError extends Error {
  constructor(override readonly cause?: unknown) {
    super("Local process was cancelled", { cause });
    this.name = "LocalProcessCancelledError";
  }
}

export class LocalProcessTimeoutError extends Error {
  constructor(readonly result: LocalProcessResult) {
    super("Local process exceeded its timeout", { cause: result });
    this.name = "LocalProcessTimeoutError";
  }
}

export class LocalProcessOutputLimitError extends Error {
  constructor(readonly result: LocalProcessResult) {
    super("Local process exceeded its output limit", { cause: result });
    this.name = "LocalProcessOutputLimitError";
  }
}

export class LocalProcessTerminationError extends UnconfirmedInvocationTerminationError {
  constructor(
    readonly processIds: readonly (string | number)[],
    override readonly cause?: unknown,
  ) {
    super("timeout");
    this.name = "LocalProcessTerminationError";
  }
}

interface CapturedOutput {
  bytes: Buffer;
  truncated: boolean;
}

function validateOutputLimitBytes(value: number): void {
  if (!outputLimitBytesSchema.safeParse(value).success) {
    throw new RangeError(
      "Local process outputLimitBytes must be a non-negative integer",
    );
  }
}

function effectiveTimeoutMs(value: number | undefined): number {
  if (value !== undefined && !timeoutMsSchema.safeParse(value).success) {
    throw new RangeError("Local process timeoutMs must be a positive integer");
  }
  return Math.min(
    value ?? DEFAULT_LOCAL_PROCESS_TIMEOUT_MS,
    MAX_LOCAL_PROCESS_TIMEOUT_MS,
  );
}

function capture<E>(stream: Stream.Stream<Uint8Array, E>, limit: number) {
  const output: CapturedOutput = { bytes: Buffer.alloc(0), truncated: false };
  const read = Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      const merged = Buffer.concat([output.bytes, chunk]);
      output.truncated ||= merged.byteLength > limit;
      output.bytes = limit === 0 ? Buffer.alloc(0) : merged.subarray(-limit);
    }),
  );
  return { output, read };
}

async function confirmProcessGroupTermination(
  identity: OwnedProcessIdentity | undefined,
): Promise<void> {
  if (identity === undefined || (await confirmOwnedProcessStopped(identity)))
    return;
  const stopped = await terminateOwnedProcess(identity, "SIGKILL");
  if (!stopped.confirmed)
    throw new LocalProcessTerminationError([identity.pid]);
}

function createProcessEffect(request: LocalProcessRequest, timeoutMs: number) {
  let processIdentity: OwnedProcessIdentity | undefined;
  let stdoutCapture: CapturedOutput | undefined;
  let stderrCapture: CapturedOutput | undefined;
  const program = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env ?? process.env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        forceKillAfter: Duration.millis(PROCESS_TERMINATION_GRACE_MS),
      });
      const child = yield* command;
      const registerProcess = request.onOwnedProcessAcquired;
      const acquiredIdentity = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await captureOwnedProcessIdentity(child.pid);
          } catch (cause) {
            if (await confirmOwnedProcessGroupStopped(child.pid)) {
              return undefined;
            }
            throw new AggregateError(
              [cause],
              "Could not identify a local process group that may still be active",
            );
          }
        },
        catch: (cause) => cause,
      });
      processIdentity = acquiredIdentity;
      if (registerProcess !== undefined && acquiredIdentity !== undefined) {
        yield* Effect.tryPromise({
          try: () => registerProcess(acquiredIdentity.pid),
          catch: (cause) => cause,
        });
      }
      const stdout = capture(child.stdout, request.outputLimitBytes);
      const stderr = capture(child.stderr, request.outputLimitBytes);
      stdoutCapture = stdout.output;
      stderrCapture = stderr.output;
      const { exitCode } = yield* Effect.all(
        {
          exitCode: child.exitCode,
          stdout: stdout.read,
          stderr: stderr.read,
        },
        { concurrency: "unbounded" },
      );
      return {
        exitCode,
        stdout: stdout.output.bytes.toString("utf8"),
        stderr: stderr.output.bytes.toString("utf8"),
        stdoutTruncated: stdout.output.truncated,
        stderrTruncated: stderr.output.truncated,
      };
    }),
  );
  const bounded = Effect.timeoutOption(program, Duration.millis(timeoutMs));
  return {
    processIdentity: () => processIdentity,
    capturedOutput: () => ({
      stdout: stdoutCapture?.bytes.toString("utf8") ?? "",
      stderr: stderrCapture?.bytes.toString("utf8") ?? "",
      stdoutTruncated: stdoutCapture?.truncated ?? false,
      stderrTruncated: stderrCapture?.truncated ?? false,
    }),
    effect: Effect.provide(
      bounded,
      Layer.provideMerge(
        NodeChildProcessSpawner.layer,
        Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
      ),
    ),
  };
}

function result(
  request: LocalProcessRequest,
  startedAt: number,
  value: ProcessOutput,
  timedOut: boolean,
  cancelled: boolean,
): LocalProcessResult {
  const endedAt = Date.now();
  return {
    ...value,
    exitCode: timedOut ? 124 : value.exitCode,
    taskId: request.taskId,
    invocationId: request.invocationId,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    outcome: cancelled ? "cancelled" : timedOut ? "timed_out" : "completed",
    timedOut,
    cancelled,
  };
}

/** Execute one argv process through Effect's scoped Node process service. */
export async function runLocalProcess(
  request: LocalProcessRequest,
  nativeContext: Context.Context<never> = Context.empty(),
): Promise<LocalProcessResult> {
  validateOutputLimitBytes(request.outputLimitBytes);
  const timeoutMs = effectiveTimeoutMs(request.timeoutMs);
  if (request.signal?.aborted) {
    throw new LocalProcessCancelledError(request.signal.reason);
  }

  const startedAt = Date.now();
  const processEffect = createProcessEffect(request, timeoutMs);
  let stoppedBySignal = false;
  let failed = false;
  let value: Option.Option<ProcessOutput>;
  let runCause: unknown;
  try {
    value = await Effect.runPromiseWith(nativeContext)(processEffect.effect, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (cause) {
    failed = true;
    runCause = cause;
    stoppedBySignal = request.signal?.aborted === true;
    value = Option.none();
  }

  try {
    await confirmProcessGroupTermination(processEffect.processIdentity());
  } catch (cleanupCause) {
    if (cleanupCause instanceof LocalProcessTerminationError) {
      throw new LocalProcessTerminationError(
        cleanupCause.processIds,
        failed ? runCause : cleanupCause.cause,
      );
    }
    throw cleanupCause;
  }
  if (failed && !stoppedBySignal) {
    throw new LocalProcessSpawnError(runCause);
  }
  const normalized = result(
    request,
    startedAt,
    Option.isSome(value)
      ? value.value
      : {
          exitCode: 124,
          ...processEffect.capturedOutput(),
        },
    !stoppedBySignal && Option.isNone(value),
    stoppedBySignal,
  );
  if (normalized.timedOut) throw new LocalProcessTimeoutError(normalized);
  if (normalized.stdoutTruncated || normalized.stderrTruncated) {
    throw new LocalProcessOutputLimitError(normalized);
  }
  return normalized;
}
