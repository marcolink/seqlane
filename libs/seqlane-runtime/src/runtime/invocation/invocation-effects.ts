import type {
  SeqlaneExecutorActivity,
  SeqlaneManagedEffect,
} from "../execution/executor.js";

/** Tracks managed work that outlives an executor's initial response. */
export class InvocationEffects {
  readonly #activeActivityIds = new Set<string>();
  readonly #effectCompletions = new Set<Promise<void>>();
  readonly #waiters = new Set<() => void>();
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

  async waitForTermination(): Promise<void> {
    while (!this.#isTerminated()) {
      await new Promise<void>((resolve) => {
        this.#waiters.add(resolve);
      });
    }
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  #isTerminated(): boolean {
    return (
      this.#activeActivityIds.size === 0 && this.#effectCompletions.size === 0
    );
  }

  #notifyIfTerminated(): void {
    if (!this.#isTerminated()) return;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}
