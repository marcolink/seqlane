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
