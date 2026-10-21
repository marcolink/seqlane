import { Effect } from "effect";
import { CodexAdapterError } from "./errors.js";

export const CODEX_PREFLIGHT_TIMEOUT_MS = 15_000;

export class CodexRequestDeadlineError extends CodexAdapterError {
  constructor(
    readonly operation: string,
    milliseconds: number,
  ) {
    super(
      "cancellation",
      `Codex ${operation} did not complete within ${milliseconds}ms`,
    );
    this.name = "CodexRequestDeadlineError";
  }
}

export async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  operation: string,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = new CodexRequestDeadlineError(operation, milliseconds);
  const cancelled = () =>
    signal?.reason ??
    new CodexAdapterError("cancellation", `Codex ${operation} was cancelled`);
  const source = Effect.tryPromise({
    try: () => promise,
    catch: (cause) => cause,
  });
  const deadline = Effect.sleep(`${milliseconds} millis`).pipe(
    Effect.andThen(Effect.fail(timeout)),
  );
  const result = Effect.raceFirst(source, deadline);
  const interruptFromSignal =
    signal === undefined
      ? result
      : Effect.raceFirst(
          result,
          Effect.callback<never, unknown>((resume) => {
            const abort = (): void => resume(Effect.fail(cancelled()));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            return Effect.sync(() =>
              signal.removeEventListener("abort", abort),
            );
          }),
        );
  return Effect.runPromise(interruptFromSignal);
}
