import { afterEach } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { buildWorkflow, type AuthoredWorkflow } from "@seqlane/core";
import { createOperationalWorkflow } from "./registration.js";
import type { OperationalWorkflowSource } from "./types.js";

let scope = Scope.makeUnsafe();

/** Keep private service resources alive between test calls, then release them. */
export async function runTest<A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(Scope.Scope, scope)),
  );
}

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  scope = Scope.makeUnsafe();
});

/** Register a real authored workflow; malformed Plan cases keep explicit setup. */
export function registerAuthoredWorkflow<I, O>(
  key: string,
  workflow: AuthoredWorkflow<I, O>,
  overrides: Pick<OperationalWorkflowSource, "eventSink"> = {},
) {
  const built = buildWorkflow(workflow);
  return createOperationalWorkflow({ key, ...built, workflow, ...overrides });
}
