import { Clock, Duration, Effect, Schedule } from "effect";
import { ClassifierFailure } from "./types.js";
import {
  retryDelayFor,
  RetryableSystemOneAttempt,
} from "./system-one-retry.js";

class RetryBudgetStop extends Error {
  constructor(readonly failure: ClassifierFailure) {
    super("Retry delay exceeds the remaining classifier transport budget");
  }
}

export function runSystemOneOperation<A, R>(options: {
  readonly budgetMs: number;
  readonly maxAttempts: number;
  readonly attempt: (attemptIndex: number) => Effect.Effect<A, unknown, R>;
}): Effect.Effect<A, unknown, R> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.monotonicTimeNanos;
    const lastFailure: { value?: RetryableSystemOneAttempt } = {};
    let attemptIndex = 0;
    const attempt = Effect.suspend(() => {
      const currentAttempt = attemptIndex++;
      return Effect.gen(function* () {
        if (currentAttempt > 0) {
          const remaining =
            options.budgetMs -
            Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000;
          if (remaining <= 0) {
            return yield* Effect.fail(
              new ClassifierFailure(
                "deadline",
                "Classifier request exceeded the 20-second transport budget",
                lastFailure.value === undefined
                  ? undefined
                  : { cause: lastFailure.value.failure },
              ),
            );
          }
        }
        const result = yield* options.attempt(currentAttempt);
        const elapsed =
          Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000;
        if (elapsed >= options.budgetMs) {
          return yield* Effect.fail(
            new ClassifierFailure(
              "deadline",
              "Classifier request exceeded the 20-second transport budget",
              lastFailure.value === undefined
                ? undefined
                : { cause: lastFailure.value.failure },
            ),
          );
        }
        return result;
      });
    }).pipe(
      Effect.tapError((cause) => {
        if (cause instanceof RetryableSystemOneAttempt)
          lastFailure.value = cause;
        return Effect.void;
      }),
    );
    const retrySchedule = Schedule.recurs(options.maxAttempts - 1).pipe(
      Schedule.modifyDelay(() =>
        Effect.gen(function* () {
          const failure = lastFailure.value;
          const elapsed =
            Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000;
          const remaining = Math.max(0, options.budgetMs - elapsed);
          const delay = retryDelayFor(
            attemptIndex - 1,
            failure?.retryAfter ?? null,
            yield* Clock.currentTimeMillis,
            remaining,
          );
          if (delay === undefined) {
            if (failure === undefined) return Duration.zero;
            return yield* Effect.fail(new RetryBudgetStop(failure.failure));
          }
          return Duration.millis(delay);
        }),
      ),
    );
    const retrying = Effect.retry(attempt, {
      schedule: retrySchedule,
      while: (cause) => cause instanceof RetryableSystemOneAttempt,
    });
    const timed = yield* Effect.raceFirst(
      retrying.pipe(
        Effect.mapError((cause) =>
          cause instanceof RetryableSystemOneAttempt
            ? cause.failure
            : cause instanceof RetryBudgetStop
              ? cause.failure
              : cause,
        ),
        Effect.map((value) => ({ _tag: "Success" as const, value })),
      ),
      Effect.sleep(Duration.millis(options.budgetMs)).pipe(
        Effect.as({ _tag: "Deadline" as const }),
      ),
    );
    if (timed._tag === "Deadline") {
      return yield* Effect.fail(
        new ClassifierFailure(
          "deadline",
          "Classifier request exceeded the 20-second transport budget",
          lastFailure.value === undefined
            ? undefined
            : { cause: lastFailure.value.failure },
        ),
      );
    }
    return timed.value;
  });
}
