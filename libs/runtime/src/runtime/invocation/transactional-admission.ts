import { Effect, Exit } from "effect";
import { awaitAbort } from "../execution/await-abort.js";

export type AdmissionDecision<A> =
  | { readonly _tag: "Acquired"; readonly lease: A }
  | {
      readonly _tag: "Waiting";
      readonly reason: string;
      readonly notify: () => void;
    };

/** Transactions contain only immutable state transitions. Notify after commit. */
export function acquireTransactional<A>(options: {
  readonly register: Effect.Effect<void>;
  readonly attempt: Effect.Effect<AdmissionDecision<A>, unknown>;
  readonly cleanup: (failed: boolean) => Effect.Effect<void>;
  readonly signal?: AbortSignal;
}): Effect.Effect<A, unknown> {
  const wait = Effect.gen(function* () {
    let previousReason: string | undefined;
    while (true) {
      if (options.signal?.aborted)
        return yield* Effect.fail(options.signal.reason);
      const decision = yield* Effect.tx(
        Effect.gen(function* () {
          const decision = yield* options.attempt;
          if (decision._tag === "Waiting" && decision.reason === previousReason)
            return yield* Effect.txRetry;
          return decision;
        }),
      );
      if (decision._tag === "Acquired") return decision.lease;
      previousReason = decision.reason;
      yield* Effect.sync(decision.notify);
    }
  });
  return Effect.scoped(
    Effect.gen(function* () {
      if (options.signal?.aborted)
        return yield* Effect.fail(options.signal.reason);
      // Install cleanup before an interruptible transaction can commit ownership.
      // The token also covers a committed lease that loses an abort handoff race.
      yield* Effect.acquireRelease(options.register, (_, exit) =>
        options.cleanup(Exit.isFailure(exit)),
      );
      return yield* options.signal === undefined
        ? wait
        : Effect.raceFirst(
            wait,
            awaitAbort(options.signal, "Admission cancelled"),
          );
    }),
  );
}

/** Legacy lease callbacks evaluate only synchronous, pure state transactions. */
export function admissionSync<A>(effect: Effect.Effect<A>): A {
  return Effect.runSync(Effect.tx(effect));
}
