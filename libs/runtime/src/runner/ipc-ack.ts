import { Effect } from "effect";

export const DEFAULT_IPC_ACK_TIMEOUT_MS = 5_000;

/** Waits for the Node IPC callback with an Effect-owned bounded deadline. */
export function sendWithAcknowledgement(
  send: (callback: (error?: Error | null) => void) => boolean,
  timeoutMs = DEFAULT_IPC_ACK_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(
      new RangeError("timeoutMs must be a positive integer"),
    );
  }
  const acknowledgement = Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        try {
          send((error) => (error == null ? resolve() : reject(error)));
        } catch (cause) {
          reject(cause);
        }
      }),
    catch: (cause) => cause,
  });
  return Effect.runPromise(
    Effect.timeout(`${timeoutMs} millis`)(acknowledgement),
  );
}
