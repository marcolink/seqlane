import { ClassifierFailure } from "./types.js";

const CLASSIFIER_MAX_ATTEMPTS = 4;
const CLASSIFIER_RETRY_BACKOFF_MS = [200, 400, 800] as const;
const HTTP_SHORT_WEEKDAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const HTTP_LONG_WEEKDAY =
  "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const HTTP_MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const HTTP_TIME = "(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]";
const HTTP_DATE_PATTERN = new RegExp(
  `^(?:${HTTP_SHORT_WEEKDAY}, (?:0[1-9]|[12][0-9]|3[01]) ${HTTP_MONTH} \\d{4} ${HTTP_TIME} GMT|${HTTP_LONG_WEEKDAY}, (?:0[1-9]|[12][0-9]|3[01])-${HTTP_MONTH}-\\d{2} ${HTTP_TIME} GMT|${HTTP_SHORT_WEEKDAY} ${HTTP_MONTH} {1,2}(?:[1-9]|[12][0-9]|3[01]) ${HTTP_TIME} \\d{4})$`,
);

export class RetryableSystemOneAttempt extends Error {
  constructor(
    readonly failure: ClassifierFailure,
    readonly retryAfter?: string,
  ) {
    super(failure.message, { cause: failure });
    this.name = "RetryableSystemOneAttempt";
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

function retryAfterDelayMs(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > Number.MAX_SAFE_INTEGER / 1_000
      ? Number.POSITIVE_INFINITY
      : seconds * 1_000;
  }
  if (!HTTP_DATE_PATTERN.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function retryDelayFor(
  failedAttemptIndex: number,
  retryAfter: string | null,
  now: number,
  remainingBudgetMs: number,
): number | undefined {
  const backoff = CLASSIFIER_RETRY_BACKOFF_MS[failedAttemptIndex];
  if (backoff === undefined) return undefined;
  const requestedDelay = Math.max(
    backoff,
    retryAfterDelayMs(retryAfter, now) ?? 0,
  );
  return Number.isFinite(requestedDelay) && requestedDelay < remainingBudgetMs
    ? requestedDelay
    : undefined;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function runSystemOneAttempts<Result>(options: {
  readonly attempt: (attemptIndex: number) => Promise<Result>;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly monotonicNow: () => number;
  readonly assertActive: (lastCause?: unknown) => void;
}): Promise<Result> {
  let lastAttemptFailure: ClassifierFailure | undefined;
  for (let attemptIndex = 0; attemptIndex < CLASSIFIER_MAX_ATTEMPTS;) {
    options.assertActive(lastAttemptFailure);
    try {
      return await options.attempt(attemptIndex);
    } catch (cause) {
      if (!(cause instanceof RetryableSystemOneAttempt)) throw cause;
      lastAttemptFailure = cause.failure;
      options.assertActive(cause);
      if (attemptIndex + 1 >= CLASSIFIER_MAX_ATTEMPTS) throw cause.failure;
      const retryDelay = retryDelayFor(
        attemptIndex,
        cause.retryAfter ?? null,
        Date.now(),
        options.deadline - options.monotonicNow(),
      );
      if (retryDelay === undefined) throw cause.failure;
      try {
        await waitForRetry(retryDelay, options.signal);
      } catch (waitCause) {
        options.assertActive(cause);
        throw waitCause;
      }
      options.assertActive(cause);
      attemptIndex += 1;
    }
  }
  throw new Error("Classifier attempt limit ended without a result");
}
