import { LocalSandbox } from "@mastra/core/workspace";
import type { InvocationId, TaskExecResult, TaskId } from "@seqlane/core";
import { z } from "zod";

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

function waitForNextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

async function waitForProcessGroupsToExit(
  processIds: readonly string[],
): Promise<void> {
  if (process.platform === "win32") return;

  const groupIds = processIds
    .map(Number)
    .filter((processId) => Number.isInteger(processId) && processId > 0);
  while (
    groupIds.some((groupId) => {
      try {
        process.kill(-groupId, 0);
        return true;
      } catch {
        return false;
      }
    })
  ) {
    await waitForNextTurn();
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
  validateTimeoutMs(request.timeoutMs);
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
          ...(request.timeoutMs === undefined
            ? {}
            : { timeout: request.timeoutMs }),
        },
      );
    } catch (cause) {
      if (request.signal?.aborted) {
        throw new MastraProcessCancelledError(request.signal.reason);
      }
      throw new MastraProcessSpawnError(cause);
    }

    return normalizeMastraProcessResult(result, request, startedAt, Date.now());
  } finally {
    cancellationBarrier.dispose();
    try {
      await cancellationBarrier.wait();
    } finally {
      await sandbox.destroy();
    }
  }
}
