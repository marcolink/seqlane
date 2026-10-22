import { Cause, Duration, Effect, Exit } from "effect";

export const DEFAULT_IPC_ACK_TIMEOUT_MS = 5_000;

/** Waits for the Node IPC callback with an Effect-owned bounded deadline. */
export function sendWithAcknowledgement(
  send: (callback: (error?: Error | null) => void) => boolean,
  timeoutMs = DEFAULT_IPC_ACK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(
      new RangeError("timeoutMs must be a positive integer"),
    );
  }
  const acknowledgement = Effect.callback<void, unknown>((resume) => {
    let settled = false;
    let listening = false;
    const removeAbortListener = (): void => {
      if (!listening) return;
      listening = false;
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (effect: Effect.Effect<void, unknown>): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      resume(effect);
    };
    const onAbort = (): void => finish(Effect.fail(signal?.reason));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    listening = signal !== undefined;
    if (signal?.aborted) {
      onAbort();
    } else {
      try {
        send((error) => {
          finish(error == null ? Effect.void : Effect.fail(error));
        });
      } catch (cause) {
        finish(Effect.fail(cause));
      }
    }

    return Effect.sync(removeAbortListener);
  });
  return Effect.runPromiseExit(
    Effect.timeout(acknowledgement, Duration.millis(timeoutMs)),
  ).then((exit) => {
    if (Exit.isFailure(exit)) return Promise.reject(Cause.squash(exit.cause));
    return undefined;
  });
}
