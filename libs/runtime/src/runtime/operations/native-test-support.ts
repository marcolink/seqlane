import { afterEach } from "vitest";
import { Cause, Effect, Exit, Scope } from "effect";

let scope = Scope.makeUnsafe();

/** Keep private service resources alive between test calls, then release them. */
export async function runTest<A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provideService(Scope.Scope, scope)),
  );
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  scope = Scope.makeUnsafe();
});
