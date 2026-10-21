import type {
  SeqlaneExecutorActivity,
  SeqlaneManagedEffect,
} from "../execution/executor.js";
import { Effect, Option } from "effect";

export class InvocationTerminationTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(
      `Tracked executor activity did not terminate within ${timeoutMs}ms`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "InvocationTerminationTimeoutError";
  }
}

/** Tracks managed work that outlives an executor's initial response. */
export class InvocationEffects {
  readonly #activeActivityIds = new Set<string>();
  readonly #effectCompletions = new Set<Promise<void>>();
  readonly #waiters = new Set<() => void>();
  readonly #terminationTimeoutMs: number;

  constructor(terminationTimeoutMs = 30_000) {
    this.#terminationTimeoutMs = terminationTimeoutMs;
  }

  #failure: { readonly cause: unknown } | undefined;

  observeActivity(
    activity: Pick<SeqlaneExecutorActivity, "activityId" | "state">,
  ): void {
    if (activity.state === "started") {
      this.#activeActivityIds.add(activity.activityId);
    } else if (activity.state === "succeeded" || activity.state === "failed") {
      this.#activeActivityIds.delete(activity.activityId);
    }
    this.#notifyIfTerminated();
  }

  track(effect: SeqlaneManagedEffect): void {
    this.#trackTermination(effect.termination);
  }

  trackTermination(termination: Promise<unknown>): void {
    this.#trackTermination(termination);
  }

  #trackTermination(termination: Promise<unknown>): void {
    const completion = Promise.resolve(termination).then(
      () => {
        this.#effectCompletions.delete(completion);
        this.#notifyIfTerminated();
      },
      (cause: unknown) => {
        this.#effectCompletions.delete(completion);
        this.#failure ??= { cause };
        this.#notifyIfTerminated();
      },
    );
    this.#effectCompletions.add(completion);
  }

  waitForTerminationEffect(
    timeoutMs = this.#terminationTimeoutMs,
  ): Effect.Effect<void, unknown> {
    const terminated = this.#isTerminated()
      ? Effect.succeed(Option.some(undefined))
      : Effect.callback<void>((resume) => {
          if (this.#isTerminated()) {
            resume(Effect.void);
            return;
          }
          const wake = (): void => resume(Effect.void);
          this.#waiters.add(wake);
          return Effect.sync(() => this.#waiters.delete(wake));
        }).pipe(Effect.timeoutOption(timeoutMs));
    return Effect.flatMap(terminated, (completed) => {
      if (Option.isNone(completed))
        return Effect.fail(
          new InvocationTerminationTimeoutError(
            timeoutMs,
            this.#failure?.cause,
          ),
        );
      if (this.#failure !== undefined) return Effect.fail(this.#failure.cause);
      return Effect.void;
    });
  }

  /** Temporary interop for the Promise executor path, removed with S9 cutover. */
  waitForTermination(timeoutMs = this.#terminationTimeoutMs): Promise<void> {
    return Effect.runPromise(this.waitForTerminationEffect(timeoutMs));
  }

  #isTerminated(): boolean {
    return (
      this.#activeActivityIds.size === 0 && this.#effectCompletions.size === 0
    );
  }

  #notifyIfTerminated(): void {
    if (!this.#isTerminated()) return;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of waiters) resolve();
  }
}
