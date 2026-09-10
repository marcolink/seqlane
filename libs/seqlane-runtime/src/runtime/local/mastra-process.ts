import { LocalSandbox } from "@mastra/core/workspace";
import type { InvocationId, TaskExecResult, TaskId } from "@seqlane/core";
import { z } from "zod";
import { UnconfirmedInvocationTerminationError } from "../execution/executor.js";

interface MastraProcessResult extends TaskExecResult {
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

export const DEFAULT_MASTRA_PROCESS_TIMEOUT_MS = 30_000;
export const MAX_MASTRA_PROCESS_TIMEOUT_MS = 300_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_TERMINATION_POLL_INTERVAL_MS = 25;

const mastraCommandResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  executionTimeMs: z.number().nonnegative(),
  timedOut: z.boolean().optional().default(false),
  killed: z.boolean().optional().default(false),
  stdoutTruncated: z.boolean().optional().default(false),
  stderrTruncated: z.boolean().optional().default(false),
});

export interface MastraProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly outputLimitBytes: number;
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class MastraProcessSpawnError extends Error {
  constructor(override readonly cause: unknown) {
    super("Mastra process could not start", { cause });
    this.name = "MastraProcessSpawnError";
  }
}

export class MastraProcessResultError extends Error {
  constructor(override readonly cause: unknown) {
    super("Mastra process returned malformed output", { cause });
    this.name = "MastraProcessResultError";
  }
}

export class MastraProcessCancelledError extends Error {
  constructor(override readonly cause?: unknown) {
    super("Mastra process was cancelled", { cause });
    this.name = "MastraProcessCancelledError";
  }
}

export class MastraProcessTimeoutError extends Error {
  constructor(readonly result: MastraProcessResult) {
    super("Mastra process exceeded its timeout", { cause: result });
    this.name = "MastraProcessTimeoutError";
  }
}

export class MastraProcessOutputLimitError extends Error {
  constructor(readonly result: MastraProcessResult) {
    super("Mastra process exceeded its output limit", { cause: result });
    this.name = "MastraProcessOutputLimitError";
  }
}

export class MastraProcessTerminationError extends UnconfirmedInvocationTerminationError {
  constructor(readonly processIds: readonly (string | number)[]) {
    super("timeout");
    this.name = "MastraProcessTerminationError";
  }
}

function validateOutputLimitBytes(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      "Mastra process outputLimitBytes must be a non-negative integer",
    );
  }
}

function validateTimeoutMs(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new RangeError("Mastra process timeoutMs must be a positive integer");
  }
}

function effectiveTimeoutMs(value: number | undefined): number {
  validateTimeoutMs(value);
  return Math.min(
    value ?? DEFAULT_MASTRA_PROCESS_TIMEOUT_MS,
    MAX_MASTRA_PROCESS_TIMEOUT_MS,
  );
}

function waitForNextTurn(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function activeProcessGroups(
  processIds: readonly (string | number)[],
): readonly number[] {
  return processIds
    .map(Number)
    .filter((processId) => Number.isInteger(processId) && processId > 0)
    .filter((groupId) => {
      try {
        process.kill(-groupId, 0);
        return true;
      } catch {
        return false;
      }
    });
}

async function waitForProcessGroupsToExit(
  processIds: readonly string[],
  timeoutMs = PROCESS_TERMINATION_GRACE_MS,
): Promise<void> {
  if (process.platform === "win32") return;

  const deadline = Date.now() + timeoutMs;
  while (activeProcessGroups(processIds).length > 0 && Date.now() < deadline) {
    await waitForNextTurn(
      Math.min(PROCESS_TERMINATION_POLL_INTERVAL_MS, deadline - Date.now()),
    );
  }
  const remaining = activeProcessGroups(processIds);
  if (remaining.length === 0) return;

  for (const groupId of remaining) {
    try {
      process.kill(-groupId, "SIGKILL");
    } catch {
      // The group may have exited between the liveness check and escalation.
    }
  }

  const killDeadline = Date.now() + timeoutMs;
  while (
    activeProcessGroups(processIds).length > 0 &&
    Date.now() < killDeadline
  ) {
    await waitForNextTurn(
      Math.min(PROCESS_TERMINATION_POLL_INTERVAL_MS, killDeadline - Date.now()),
    );
  }
  if (activeProcessGroups(processIds).length > 0) {
    throw new MastraProcessTerminationError(processIds);
  }
}

function createCancellationBarrier(
  sandbox: LocalSandbox,
  signal: AbortSignal | undefined,
): { readonly wait: () => Promise<void>; readonly dispose: () => void } {
  let termination: Promise<void> | undefined;

  const beginTermination = (): void => {
    termination ??= (async () => {
      const processes = await sandbox.processes.list();
      const processIds = processes.map(({ pid }) => pid);
      await Promise.all(processIds.map((pid) => sandbox.processes.kill(pid)));
      await waitForProcessGroupsToExit(processIds);
    })();
  };

  signal?.addEventListener("abort", beginTermination, { once: true });
  return {
    wait: async () => {
      if (signal?.aborted) beginTermination();
      await termination;
    },
    dispose: () => signal?.removeEventListener("abort", beginTermination),
  };
}

export function normalizeMastraProcessResult(
  value: unknown,
  request: Pick<MastraProcessRequest, "taskId" | "invocationId" | "signal">,
  startedAt: number,
  endedAt: number,
): MastraProcessResult {
  const parsed = mastraCommandResultSchema.safeParse(value);
  if (!parsed.success) throw new MastraProcessResultError(parsed.error);

  const timedOut = parsed.data.timedOut;
  const cancelled = request.signal?.aborted === true && !timedOut;
  return {
    exitCode: parsed.data.exitCode,
    stdout: parsed.data.stdout,
    stderr: parsed.data.stderr,
    taskId: request.taskId,
    invocationId: request.invocationId,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    outcome: cancelled ? "cancelled" : timedOut ? "timed_out" : "completed",
    timedOut,
    cancelled,
    stdoutTruncated: parsed.data.stdoutTruncated,
    stderrTruncated: parsed.data.stderrTruncated,
  };
}

/** Execute one argv-based foreground process with Mastra's local sandbox. */
export async function runMastraProcess(
  request: MastraProcessRequest,
): Promise<MastraProcessResult> {
  validateOutputLimitBytes(request.outputLimitBytes);
  const timeoutMs = effectiveTimeoutMs(request.timeoutMs);
  if (request.signal?.aborted) {
    throw new MastraProcessCancelledError(request.signal.reason);
  }

  const startedAt = Date.now();
  const sandbox = new LocalSandbox({
    workingDirectory: request.cwd,
    env: process.env,
  });
  const cancellationBarrier = createCancellationBarrier(
    sandbox,
    request.signal,
  );
  try {
    const executeCommand = sandbox.executeCommand;
    if (executeCommand === undefined) {
      throw new MastraProcessSpawnError(
        new Error("Mastra sandbox does not provide executeCommand"),
      );
    }

    let result: unknown;
    try {
      result = await executeCommand.call(
        sandbox,
        request.command,
        [...request.args],
        {
          cwd: request.cwd,
          maxRetainedBytes: request.outputLimitBytes,
          ...(request.signal === undefined
            ? {}
            : { abortSignal: request.signal }),
          timeout: timeoutMs,
        },
      );
    } catch (cause) {
      if (request.signal?.aborted) {
        throw new MastraProcessCancelledError(request.signal.reason);
      }
      throw new MastraProcessSpawnError(cause);
    }

    const normalized = normalizeMastraProcessResult(
      result,
      request,
      startedAt,
      Date.now(),
    );
    if (normalized.timedOut) {
      throw new MastraProcessTimeoutError(normalized);
    }
    if (normalized.stdoutTruncated || normalized.stderrTruncated) {
      throw new MastraProcessOutputLimitError(normalized);
    }
    return normalized;
  } finally {
    cancellationBarrier.dispose();
    try {
      await cancellationBarrier.wait();
    } finally {
      await sandbox.destroy();
    }
  }
}
