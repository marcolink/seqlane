import { Effect, Queue } from "effect";
import { z } from "zod";
import { openCodeEffect } from "../effect-boundary.js";
import type { V2Client } from "./client.js";
import { sessionSchema } from "./schemas.js";

const eventSchema = z.object({
  id: sessionSchema.shape.id,
  type: z.string().min(1).max(256),
  data: z.unknown(),
});
const sessionEventSchema = z.object({
  sessionID: sessionSchema.shape.id,
  parentID: sessionSchema.shape.id.optional(),
});
const formEventSchema = z.object({
  form: sessionEventSchema,
});

/** Live events are hints. Bounded message reads remain the completion authority. */
export async function monitorWithLiveEvents(
  client: V2Client,
  ownsSession: (id: string) => boolean,
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<{ value: unknown } | undefined>,
): Promise<unknown> {
  let readFailure: unknown;
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wakeups = yield* Queue.sliding<true>(1);
          yield* Effect.forkScoped(
            monitorEvents(client, ownsSession, () =>
              Queue.offerUnsafe(wakeups, true),
            ),
          );
          while (true) {
            const result = yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                const controller = new AbortController();
                const pending = read(controller.signal);
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
            if (result !== undefined) return result.value;
            yield* Effect.raceFirst(
              Queue.take(wakeups),
              Effect.sleep("1 second"),
            );
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

function monitorEvents(
  client: V2Client,
  ownsSession: (id: string) => boolean,
  notify: () => void,
) {
  return Effect.gen(function* () {
    let delay = 250;
    const seen = new Set<string>();
    while (true) {
      const connection = Effect.acquireUseRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          const pending = consume(controller.signal);
          return { controller, pending };
        }),
        ({ pending }) => openCodeEffect(() => pending),
        ({ controller, pending }) =>
          Effect.promise(async () => {
            controller.abort();
            await pending.catch(() => undefined);
          }),
      );
      // The global stream has no replay. Rotation cannot replace recovery reads.
      yield* Effect.raceFirst(connection, Effect.sleep("45 seconds")).pipe(
        Effect.catch(() => Effect.void),
      );
      yield* Effect.sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }

    async function consume(signal: AbortSignal): Promise<void> {
      for await (const value of client.event.subscribe({ signal })) {
        const event = eventSchema.safeParse(value);
        if (!event.success) continue;
        const { type, data } = event.data;
        const parsed =
          type === "form.created"
            ? formEventSchema.safeParse(data)
            : sessionEventSchema.safeParse(data);
        if (!parsed.success) continue;
        const id =
          "form" in parsed.data
            ? parsed.data.form.sessionID
            : parsed.data.sessionID;
        const ownedParent =
          type === "session.created" &&
          "parentID" in parsed.data &&
          parsed.data.parentID !== undefined &&
          ownsSession(parsed.data.parentID);
        if (!ownsSession(id) && !ownedParent) continue;
        if (
          !type.startsWith("session.") &&
          !type.startsWith("permission.") &&
          !type.startsWith("form.")
        )
          continue;
        if (seen.has(event.data.id)) continue;
        seen.add(event.data.id);
        if (seen.size > 4096) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        delay = 250;
        notify();
      }
    }
  });
}
