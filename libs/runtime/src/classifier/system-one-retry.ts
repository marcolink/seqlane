import { ClassifierFailure } from "./types.js";

const CLASSIFIER_MAX_ATTEMPTS = 4;
const CLASSIFIER_RETRY_BACKOFF_MS = [200, 400, 800] as const;
const HTTP_SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HTTP_LONG_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const HTTP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const HTTP_SHORT_WEEKDAY = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const HTTP_LONG_WEEKDAY =
  "(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const HTTP_MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const HTTP_TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
const ASCTIME_DAY = "((?: [1-9]|[12][0-9]|3[01]))";
const IMF_FIXDATE_PATTERN = new RegExp(
  `^${HTTP_SHORT_WEEKDAY}, (\\d{2}) ${HTTP_MONTH} (\\d{4}) ${HTTP_TIME} GMT$`,
);
const RFC850_DATE_PATTERN = new RegExp(
  `^${HTTP_LONG_WEEKDAY}, (\\d{2})-${HTTP_MONTH}-(\\d{2}) ${HTTP_TIME} GMT$`,
);
const ASCTIME_DATE_PATTERN = new RegExp(
  `^${HTTP_SHORT_WEEKDAY} ${HTTP_MONTH} ${ASCTIME_DAY} ${HTTP_TIME} (\\d{4})$`,
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

function epochMsForHttpDate(options: {
  readonly weekday: string;
  readonly day: string;
  readonly month: string;
  readonly year: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  readonly weekdayNames: readonly string[];
  readonly now: number;
  readonly twoDigitYear?: boolean;
}): number | undefined {
  const month = HTTP_MONTHS.indexOf(options.month);
  const day = Number(options.day);
  const hour = Number(options.hour);
  const minute = Number(options.minute);
  const second = Number(options.second);
  const weekday = options.weekdayNames.indexOf(options.weekday);
  let year = Number(options.year);
  if (options.twoDigitYear) {
    const currentYear = new Date(options.now).getUTCFullYear();
    year += Math.floor(currentYear / 100) * 100;
    if (year > currentYear + 50) year -= 100;
  }
  if (month < 0 || weekday < 0 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCDay() !== weekday
  ) {
    return undefined;
  }
  return date.getTime();
}

function parseHttpDate(value: string, now: number): number | undefined {
  const imfFixdate = IMF_FIXDATE_PATTERN.exec(value);
  if (imfFixdate !== null) {
    return epochMsForHttpDate({
      weekday: imfFixdate[1] ?? "",
      day: imfFixdate[2] ?? "",
      month: imfFixdate[3] ?? "",
      year: imfFixdate[4] ?? "",
      hour: imfFixdate[5] ?? "",
      minute: imfFixdate[6] ?? "",
      second: imfFixdate[7] ?? "",
      weekdayNames: HTTP_SHORT_WEEKDAYS,
      now,
    });
  }

  const rfc850 = RFC850_DATE_PATTERN.exec(value);
  if (rfc850 !== null) {
    return epochMsForHttpDate({
      weekday: rfc850[1] ?? "",
      day: rfc850[2] ?? "",
      month: rfc850[3] ?? "",
      year: rfc850[4] ?? "",
      hour: rfc850[5] ?? "",
      minute: rfc850[6] ?? "",
      second: rfc850[7] ?? "",
      weekdayNames: HTTP_LONG_WEEKDAYS,
      now,
      twoDigitYear: true,
    });
  }

  const asctime = ASCTIME_DATE_PATTERN.exec(value);
  if (asctime !== null) {
    return epochMsForHttpDate({
      weekday: asctime[1] ?? "",
      month: asctime[2] ?? "",
      day: asctime[3]?.trim() ?? "",
      hour: asctime[4] ?? "",
      minute: asctime[5] ?? "",
      second: asctime[6] ?? "",
      year: asctime[7] ?? "",
      weekdayNames: HTTP_SHORT_WEEKDAYS,
      now,
    });
  }
  return undefined;
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
  const date = parseHttpDate(trimmed, now);
  return date === undefined ? undefined : Math.max(0, date - now);
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
