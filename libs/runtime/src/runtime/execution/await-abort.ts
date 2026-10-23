import { Effect } from "effect";

/** Await an AbortSignal as an Effect failure with scoped listener cleanup. */
export function awaitAbort(
  signal: AbortSignal,
  message: string,
): Effect.Effect<never, unknown> {
  return Effect.callback((resume) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resume(Effect.fail(signal.aborted ? signal.reason : new Error(message)));
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}
