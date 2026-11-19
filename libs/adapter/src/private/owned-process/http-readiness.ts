import { Effect, Option } from "effect";

export class HttpReadinessError extends Error {
  readonly code = "HTTP_READINESS_TIMEOUT";

  constructor(url: string | undefined, cause?: Error) {
    super(
      `Service did not become ready: ${url ?? "health endpoint unavailable"}. ${cause?.message ?? "The health request did not complete"}`,
      { cause },
    );
    this.name = "HttpReadinessError";
  }
}

export class HttpHealthcheckError extends Error {
  readonly code = "HTTP_HEALTHCHECK_FAILED";

  constructor(cause: unknown) {
    super("Health check failed", { cause });
    this.name = "HttpHealthcheckError";
  }
}

interface HttpReadinessOptions<E> {
  readonly url: string | (() => string | undefined);
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  /** Lifecycle failures stop polling immediately and retain their cause. */
  readonly beforeAttempt?: Effect.Effect<void, E>;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
  /** False retries; rejection is a fatal check failure with its original cause. */
  readonly healthcheck?: (url: string, signal: AbortSignal) => Promise<boolean>;
}

function probe<E>(url: string, options: HttpReadinessOptions<E>) {
  const check = options.healthcheck;
  const request =
    check === undefined
      ? Effect.tryPromise({
          try: (signal) =>
            (options.fetch ?? fetch)(url, { headers: options.headers, signal }),
          catch: (cause) =>
            new Error(`Health request failed: ${url}`, { cause }),
        }).pipe(
          Effect.flatMap((response) =>
            Effect.ensuring(
              response.ok
                ? Effect.void
                : Effect.fail(
                    new Error(`Health returned HTTP ${response.status}`),
                  ),
              Effect.tryPromise(() =>
                Promise.resolve(response.body?.cancel()),
              ).pipe(Effect.catch(() => Effect.void)),
            ),
          ),
        )
      : Effect.tryPromise({
          try: (signal) => check(url, signal),
          catch: (cause) => new HttpHealthcheckError(cause),
        }).pipe(
          Effect.flatMap((ready) =>
            ready
              ? Effect.void
              : Effect.fail(new Error("Health check reported not ready")),
          ),
        );

  // A listening service can accept a request before attaching its HTTP handler.
  return request.pipe(
    Effect.timeout("2 seconds"),
    Effect.catchTag("TimeoutError", (cause) =>
      Effect.fail(new Error(`Health request timed out: ${url}`, { cause })),
    ),
  );
}

/** Owns bounded HTTP probes, retries, and request cleanup within a startup budget. */
export function waitForHttpHealth<E = never>(
  options: HttpReadinessOptions<E>,
): Effect.Effect<string, E | HttpReadinessError | HttpHealthcheckError> {
  return Effect.suspend(() => {
    let lastUrl: string | undefined;
    let lastFailure: Error | undefined;
    const poll = Effect.gen(function* () {
      while (true) {
        if (options.beforeAttempt !== undefined) yield* options.beforeAttempt;
        lastUrl = typeof options.url === "string" ? options.url : options.url();
        if (lastUrl !== undefined) {
          const ready = yield* probe(lastUrl, options).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              error instanceof HttpHealthcheckError
                ? Effect.fail(error)
                : Effect.sync(() => {
                    lastFailure = error;
                    return false;
                  }),
            ),
          );
          if (ready) return lastUrl;
        }
        yield* Effect.sleep(options.pollIntervalMs ?? 1_000);
      }
    });
    return poll.pipe(
      Effect.timeoutOption(options.timeoutMs),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(new HttpReadinessError(lastUrl, lastFailure)),
      ),
    );
  });
}
