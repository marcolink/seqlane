import { Clock, Effect, Queue } from "effect";
import { openCodeEffect } from "../effect-boundary.js";
import type {
  LiveEventDispatcher,
  LiveReadHint,
} from "./live-event-dispatcher.js";

/** Live events are hints. Only full reads can establish completion. */
export async function monitorWithLiveEvents(
  events: LiveEventDispatcher,
  ownsSession: (id: string) => boolean,
  signal: AbortSignal,
  read: (
    signal: AbortSignal,
    hint: LiveReadHint,
  ) => Promise<{ value: unknown } | undefined>,
): Promise<unknown> {
  let readFailure: unknown;
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wakeups = yield* Queue.sliding<true>(1);
          let pendingHint: LiveReadHint | undefined;
          let hint: LiveReadHint = "full";
          let firstEvent = true;
          let lastFullRead = 0n;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              events.subscribe(ownsSession, (incoming) => {
                pendingHint =
                  pendingHint === "full" || incoming === "full"
                    ? "full"
                    : "messages";
                Queue.offerUnsafe(wakeups, true);
              }),
            ),
            (unsubscribe) => Effect.promise(unsubscribe),
          );
          while (true) {
            const started = yield* Clock.monotonicTimeNanos;
            if (hint === "full") lastFullRead = started;
            const result = yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                const controller = new AbortController();
                const pending = read(controller.signal, hint);
                return { controller, pending };
              }),
              ({ pending }) => openCodeEffect(() => pending),
              ({ controller, pending }) =>
                Effect.promise(async () => {
                  controller.abort();
                  // Join native form cancellation before interruption leaves this edge.
                  await pending.catch((cause) => {
                    readFailure = cause;
                  });
                }),
            );
            if (hint === "full" && result !== undefined) return result.value;
            while (true) {
              const now = yield* Clock.monotonicTimeNanos;
              const cooldownAt = started + 500_000_000n;
              const fullReadAt = lastFullRead + 1_000_000_000n;
              const recoveryAt =
                fullReadAt > cooldownAt ? fullReadAt : cooldownAt;
              if (now >= recoveryAt) {
                hint = "full";
                if (pendingHint !== undefined) firstEvent = false;
                pendingHint = undefined;
                break;
              }
              const readyAt = pendingHint === "full" ? recoveryAt : cooldownAt;
              if (pendingHint !== undefined && (firstEvent || now >= readyAt)) {
                hint = pendingHint;
                pendingHint = undefined;
                firstEvent = false;
                break;
              }
              const nextRead = pendingHint === undefined ? recoveryAt : readyAt;
              yield* Effect.raceFirst(
                Queue.take(wakeups),
                Effect.sleep(Number(nextRead - now) / 1_000_000),
              );
            }
            // Collapse bursts and bound snapshot reads while output grows quickly.
            yield* Effect.sleep("50 millis");
          }
        }),
      ),
      { signal },
    );
  } catch (cause) {
    throw readFailure ?? cause;
  }
}
