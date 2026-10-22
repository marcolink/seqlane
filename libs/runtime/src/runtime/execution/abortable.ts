import { awaitAbort } from "./await-abort.js";
import { Context, Effect, Fiber } from "effect";

export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const result = await Effect.runPromise(
    Effect.raceFirst(
      Effect.tryPromise({ try: () => promise, catch: (cause) => cause }),
      awaitAbort(signal, "Task execution cancelled"),
    ),
  );
  signal.throwIfAborted();
  return result;
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
    if (aborted) {
      throw new AbortWithCauseError(signal.reason, cause);
    }
    throw cause;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

class AbortWithCauseError extends Error {
  constructor(
    readonly reason: unknown,
    cause: unknown,
  ) {
    const source = reason instanceof Error ? reason : undefined;
    super(
      source?.message ?? "Adapter execution was aborted",
      cause === reason ? undefined : { cause },
    );
    this.name = source?.name ?? "AbortError";
  }
}

export interface ExecutionDeadline {
  readonly signal: AbortSignal;
  readonly started: boolean;
  start(): void;
  dispose(): Promise<void>;
}

export function createExecutionDeadline(
  signal: AbortSignal,
  timeoutMs: number,
  nativeContext: Context.Context<never> = Context.empty(),
): ExecutionDeadline {
  const controller = new AbortController();
  let started = false;
  let timeoutFiber: Fiber.Fiber<void, never> | undefined;
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
      timeoutFiber = Effect.runForkWith(nativeContext)(
        Effect.sleep(`${timeoutMs} millis`).pipe(
          Effect.flatMap(() =>
            Effect.sync(() =>
              controller.abort(
                new DOMException(
                  "Agent task execution exceeded its deadline",
                  "TimeoutError",
                ),
              ),
            ),
          ),
        ),
      );
    },
    dispose: async () => {
      signal.removeEventListener("abort", abort);
      if (timeoutFiber !== undefined)
        await Effect.runPromise(Fiber.interrupt(timeoutFiber));
    },
  };
}
