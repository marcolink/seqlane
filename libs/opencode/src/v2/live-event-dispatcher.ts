import { Effect } from "effect";
import { z } from "zod";
import { openCodeEffect } from "../effect-boundary.js";
import type { V2Client } from "./client.js";
import { OpenCodeV2Error } from "./errors.js";
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
const readHintSchema = z.enum(["messages", "full"]);
export type LiveReadHint = z.infer<typeof readHintSchema>;

interface Subscriber {
  readonly ownsSession: (id: string) => boolean;
  readonly notify: (hint: LiveReadHint) => void;
}

/** One lazy SDK subscription owns event decoding for all invocations in a run. */
export function createLiveEventDispatcher(client: V2Client) {
  const subscribers = new Set<Subscriber>();
  let closed = false;
  let active:
    { controller: AbortController; pending: Promise<void> } | undefined;
  const start = () => {
    if (closed || active !== undefined || subscribers.size === 0) return;
    const running = {
      controller: new AbortController(),
      pending: Promise.resolve(),
    };
    active = running;
    running.pending = Effect.runPromise(monitorEvents(client, subscribers), {
      signal: running.controller.signal,
    })
      .catch(() => undefined)
      .finally(() => {
        if (active === running) active = undefined;
        // A new subscriber can arrive while the last reader is being released.
        start();
      });
  };
  return {
    subscribe(
      ownsSession: Subscriber["ownsSession"],
      notify: Subscriber["notify"],
    ) {
      if (closed)
        throw new OpenCodeV2Error("execution", "event dispatcher is closed");
      const subscriber = { ownsSession, notify };
      subscribers.add(subscriber);
      start();
      return async () => {
        if (!subscribers.delete(subscriber)) return;
        const running = active;
        if (subscribers.size !== 0 || running === undefined) return;
        running.controller.abort();
        await running.pending;
      };
    },
    async close() {
      closed = true;
      subscribers.clear();
      const running = active;
      running?.controller.abort();
      await running?.pending;
    },
  };
}
export type LiveEventDispatcher = ReturnType<typeof createLiveEventDispatcher>;

function monitorEvents(client: V2Client, subscribers: ReadonlySet<Subscriber>) {
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
            await client.waitForEventStreams();
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
        if (
          !type.startsWith("session.") &&
          !type.startsWith("permission.") &&
          !type.startsWith("form.")
        )
          continue;
        const parent =
          type === "session.created" && "parentID" in parsed.data
            ? parsed.data.parentID
            : undefined;
        const matching = [...subscribers].filter(
          ({ ownsSession }) =>
            ownsSession(id) || (parent !== undefined && ownsSession(parent)),
        );
        if (matching.length === 0) continue;
        if (seen.has(event.data.id)) continue;
        seen.add(event.data.id);
        if (seen.size > 4096) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        delay = 250;
        const messageUpdate = [
          "session.message.",
          "session.tool.",
          "session.text.",
          "session.reasoning.",
        ].some((prefix) => type.startsWith(prefix));
        const hint = readHintSchema.enum[messageUpdate ? "messages" : "full"];
        for (const subscriber of matching) subscriber.notify(hint);
      }
    }
  });
}
