import { Cause, Effect, Schedule } from "effect";

function probe(url: string): Effect.Effect<void, Error> {
  const response = Effect.tryPromise({
    try: (signal) => fetch(url, { signal }),
    catch: (cause) =>
      new Error(`OpenCode health request failed: ${url}`, { cause }),
  });

  return response.pipe(
    Effect.flatMap((result) =>
      Effect.ensuring(
        result.ok
          ? Effect.void
          : Effect.fail(
              new Error(`OpenCode health returned HTTP ${result.status}`),
            ),
        Effect.tryPromise(() => Promise.resolve(result.body?.cancel())).pipe(
          Effect.catch(() => Effect.void),
        ),
      ),
    ),
  );
}

export function waitForHttpHealth(
  url: string,
  timeoutMilliseconds: number,
): Effect.Effect<void, Error | Cause.TimeoutError> {
  const polling = Effect.retry(probe(url), Schedule.spaced("1 second"));

  return Effect.timeout(polling, timeoutMilliseconds).pipe(
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error(`Service did not become ready: ${url}`)),
    ),
  );
}
