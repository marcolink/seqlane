import type { ChildProcess } from "node:child_process";
import { Deferred, Effect } from "effect";

/** Node's handle is retained only where cleanup must validate birth identity.
 * Native spawner auto-signals groups on nonzero exit, before that validation.
 * Translate each lifecycle event once; callers own scope and signaling policy.
 */
export function observeChildLifecycle(child: ChildProcess) {
  const spawned = Deferred.makeUnsafe<void, Error>();
  const exited = Deferred.makeUnsafe<
    { readonly code: number | null; readonly signal: NodeJS.Signals | null },
    Error
  >();
  child.once("spawn", () => Deferred.doneUnsafe(spawned, Effect.void));
  child.on("error", (cause: Error) => {
    Deferred.doneUnsafe(spawned, Effect.fail(cause));
    Deferred.doneUnsafe(exited, Effect.fail(cause));
  });
  child.once("exit", (code, signal) =>
    Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })),
  );
  // Node assigns a successful spawn PID synchronously. Capture state as well
  // as events so observers also cover a child that exited before subscription.
  if (child.pid !== undefined) Deferred.doneUnsafe(spawned, Effect.void);
  if (child.exitCode !== null || child.signalCode !== null)
    Deferred.doneUnsafe(
      exited,
      Effect.succeed({ code: child.exitCode, signal: child.signalCode }),
    );
  return {
    spawned: Deferred.await(spawned),
    exit: Deferred.await(exited),
    isRunning: Effect.sync(
      () =>
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null,
    ),
  };
}
