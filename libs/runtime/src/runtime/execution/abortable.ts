export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort!: (cause: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([promise, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Keeps execution ownership until the adapter settles, while preserving an
 * abort as the task outcome. Use this for work whose cleanup protects a
 * reusable external session.
 */
export async function awaitWithAbortPrecedence<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let aborted = signal.aborted;
  const onAbort = (): void => {
    aborted = true;
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await promise;
    if (aborted) throw signal.reason;
    return result;
  } catch (cause) {
    if (aborted) throw signal.reason;
    throw cause;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface ExecutionDeadline {
  readonly signal: AbortSignal;
  readonly started: boolean;
  start(): void;
  dispose(): void;
}

export function createExecutionDeadline(
  signal: AbortSignal,
  timeoutMs: number,
): ExecutionDeadline {
  const controller = new AbortController();
  let started = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    get started() {
      return started;
    },
    start: () => {
      if (started || controller.signal.aborted) return;
      started = true;
      timeout = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              "Agent task execution exceeded its deadline",
              "TimeoutError",
            ),
          ),
        timeoutMs,
      );
      timeout.unref?.();
    },
    dispose: () => {
      signal.removeEventListener("abort", abort);
      if (timeout !== undefined) clearTimeout(timeout);
    },
  };
}
