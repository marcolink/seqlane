import { Deferred, Effect } from "effect";
import type { InvocationId, SeqlaneEvent } from "@seqlane/core";

/** Waits for a selected choice arm's session source without gating the choice graph. */
export class ChoiceSourceGate {
  private readonly sourceByInvocation = new Map<InvocationId, string>();
  private readonly states = new Map<string, boolean>();
  private readonly sources = new Map<string, Deferred.Deferred<boolean>>();

  register(sourceNodeId: string, invocationId: InvocationId): void {
    this.sourceByInvocation.set(invocationId, sourceNodeId);
    if (!this.sources.has(sourceNodeId)) {
      this.sources.set(sourceNodeId, Deferred.makeUnsafe<boolean>());
    }
  }

  observe(event: SeqlaneEvent): void {
    if (
      event.type !== "invocation.succeeded" &&
      event.type !== "invocation.failed" &&
      event.type !== "invocation.skipped" &&
      event.type !== "invocation.cancelled"
    ) {
      return;
    }
    if (
      event.type === "invocation.failed" &&
      event.disposition === "retry_scheduled"
    ) {
      return;
    }
    const sourceNodeId = this.sourceByInvocation.get(event.invocationId);
    if (sourceNodeId === undefined) return;
    const succeeded = event.type === "invocation.succeeded";
    this.states.set(sourceNodeId, succeeded);
    const deferred = this.sources.get(sourceNodeId);
    if (deferred !== undefined) {
      Deferred.doneUnsafe(deferred, Effect.succeed(succeeded));
    }
  }

  waitEffect(
    sourceNodeId: string,
    signal: AbortSignal,
  ): Effect.Effect<void, unknown> {
    const deferred = this.sources.get(sourceNodeId);
    if (deferred === undefined) {
      return Effect.fail(
        new Error(`No registered choice session source "${sourceNodeId}"`),
      );
    }
    const settled = this.states.get(sourceNodeId);
    if (settled !== undefined) {
      return settled
        ? Effect.void
        : Effect.fail(
            new Error(
              `Choice session source "${sourceNodeId}" did not succeed`,
            ),
          );
    }
    if (signal.aborted)
      return Effect.fail(signal.reason ?? new Error("Choice cancelled"));

    const abort = Effect.callback<void, unknown>((resume) => {
      const onAbort = (): void => {
        resume(Effect.fail(signal.reason ?? new Error("Choice cancelled")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
    return Effect.raceFirst(Deferred.await(deferred), abort).pipe(
      Effect.flatMap((succeeded) =>
        succeeded
          ? Effect.void
          : Effect.fail(
              new Error(
                `Choice session source "${sourceNodeId}" did not succeed`,
              ),
            ),
      ),
    );
  }

  /** Promise bridge for the legacy caller while it remains in production. */
  wait(sourceNodeId: string, signal: AbortSignal): Promise<void> {
    return Effect.runPromise(this.waitEffect(sourceNodeId, signal));
  }
}
