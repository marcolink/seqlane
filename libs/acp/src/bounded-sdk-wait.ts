import { Effect, Option } from "effect";

export type SdkWaitResult<T> =
  { readonly timedOut: true } | { readonly timedOut: false; readonly value: T };

/** Bound an SDK promise while preserving a fulfilled `undefined` value. */
export function awaitSdkWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<SdkWaitResult<T>> {
  return Effect.runPromise(
    Effect.tryPromise({ try: () => operation, catch: (cause) => cause }).pipe(
      Effect.timeoutOption(timeoutMs),
    ),
  ).then((result) =>
    Option.isSome(result)
      ? { timedOut: false as const, value: result.value }
      : { timedOut: true as const },
  );
}
