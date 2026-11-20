import { randomUUID } from "node:crypto";
import { modelSelectionSchema, type ModelSelection } from "@seqlane/core";
import { Effect } from "effect";
import { z } from "zod";
import { openCodeEffect } from "../effect-boundary.js";
import { requestOptions, type V2Client } from "./client.js";
import { OpenCodeV2Error } from "./errors.js";
import { nativeModel } from "./models.js";
import {
  ownedSessions,
  runningWork,
  terminateOwnedSession,
} from "./owned-work.js";
import { sessionSchema } from "./schemas.js";
import { assertSessionModel } from "./session-model.js";

const rootSchema = sessionSchema.pick({ id: true });
const checkpointSchema = z.strictObject({ checkpoint: z.uuid() }).readonly();
const entrySchema = z.strictObject({
  snapshot: z.string().min(1),
  selection: modelSelectionSchema,
});

/** One run owns all independent native roots, including immutable snapshots. */
export function createCheckpointRegistry(client: V2Client, workspace: string) {
  const roots = new Set<string>();
  const checkpoints = new Map<string, z.infer<typeof entrySchema>>();
  let closed = false;
  const assertOpen = () => {
    if (closed)
      throw new OpenCodeV2Error("execution", "checkpoint registry is closed");
  };
  const remove = async (id: string) => {
    if (!roots.has(id)) return;
    await terminateOwnedSession(client, id, workspace);
    roots.delete(id);
  };
  const track = (value: unknown) => {
    // Record identity before validating the remaining native fields.
    const { id } = rootSchema.parse(value);
    if (roots.has(id))
      throw new OpenCodeV2Error(
        "protocol",
        "native allocation reused an owned identity",
      );
    roots.add(id);
    return id;
  };
  const read = (value: unknown) => {
    assertOpen();
    const parsed = checkpointSchema.safeParse(value);
    const entry = parsed.success
      ? checkpoints.get(parsed.data.checkpoint)
      : undefined;
    if (entry === undefined)
      throw new OpenCodeV2Error(
        "configuration",
        "checkpoint does not belong to this run",
      );
    return entrySchema.parse(entry);
  };
  const fork = (
    source: string,
    selection: ModelSelection,
    signal: AbortSignal,
    switchModel: boolean,
  ) =>
    Effect.gen(function* () {
      yield* Effect.sync(assertOpen);
      yield* Effect.try({
        try: () => signal.throwIfAborted(),
        catch: (cause) => cause,
      });
      const ids = yield* openCodeEffect(() =>
        ownedSessions(client, source, workspace, signal),
      );
      const work = yield* openCodeEffect(() =>
        runningWork(client, ids, workspace, signal),
      );
      if (work.active || work.shells.length > 0)
        return yield* Effect.fail(
          new OpenCodeV2Error("execution", "checkpoint source is busy"),
        );
      // Allocation has its own bound. Cancellation must not lose an acquired ID.
      const raw = yield* openCodeEffect((allocationSignal) =>
        client.session.fork(
          { sessionID: source },
          requestOptions(allocationSignal),
        ),
      );
      const id = yield* Effect.try({
        try: () => track(raw),
        catch: (cause) => cause,
      });
      return yield* Effect.gen(function* () {
        const session = yield* Effect.try({
          try: () => sessionSchema.parse(raw),
          catch: (cause) =>
            new OpenCodeV2Error(
              "protocol",
              "invalid native fork session",
              cause,
            ),
        });
        if (
          session.id === source ||
          session.parentID !== undefined ||
          session.fork?.sessionID !== source ||
          session.fork.boundary.type !== "through" ||
          session.location.directory !== workspace
        )
          return yield* Effect.fail(
            new OpenCodeV2Error("protocol", "invalid native fork root"),
          );
        yield* Effect.sync(assertOpen);
        yield* Effect.try({
          try: () => signal.throwIfAborted(),
          catch: (cause) => cause,
        });
        if (switchModel)
          yield* openCodeEffect(() =>
            client.session.switchModel(
              { sessionID: id, model: nativeModel(selection) },
              requestOptions(signal),
            ),
          );
        const currentRaw = yield* openCodeEffect(() =>
          client.session.get({ sessionID: id }, requestOptions(signal)),
        );
        const current = yield* Effect.try({
          try: () => sessionSchema.parse(currentRaw),
          catch: (cause) =>
            new OpenCodeV2Error(
              "protocol",
              "invalid native fork session",
              cause,
            ),
        });
        if (
          current.id !== id ||
          current.location.directory !== workspace ||
          current.parentID !== undefined
        )
          return yield* Effect.fail(
            new OpenCodeV2Error(
              "protocol",
              "native fork changed identity or workspace",
            ),
          );
        const model = yield* Effect.try({
          try: () => assertSessionModel(current, selection),
          catch: (cause) => cause,
        });
        const idle = yield* openCodeEffect(() =>
          runningWork(client, new Set([id]), workspace, signal),
        );
        if (idle.active || idle.shells.length > 0)
          return yield* Effect.fail(
            new OpenCodeV2Error("protocol", "native fork is not idle"),
          );
        return { id, model };
      }).pipe(
        Effect.onError(() =>
          openCodeEffect(() => remove(id)).pipe(Effect.orDie),
        ),
      );
    });
  return {
    track,
    remove,
    read,
    async capture(
      source: string,
      selection: ModelSelection,
      signal: AbortSignal,
    ) {
      const snapshot = await Effect.runPromise(
        fork(source, selection, signal, false),
      );
      const handle = checkpointSchema.parse({ checkpoint: randomUUID() });
      checkpoints.set(
        handle.checkpoint,
        entrySchema.parse({ snapshot: snapshot.id, selection }),
      );
      return handle;
    },
    fork(value: unknown, selection: ModelSelection, signal: AbortSignal) {
      const entry = read(value);
      return fork(entry.snapshot, selection, signal, true);
    },
    async close() {
      closed = true;
      checkpoints.clear();
      const results = await Effect.runPromise(
        Effect.forEach(
          [...roots],
          (id) => openCodeEffect(() => remove(id)).pipe(Effect.exit),
          { concurrency: 16 },
        ),
      );
      const failures = results.filter((result) => result._tag === "Failure");
      if (failures.length > 0)
        throw new OpenCodeV2Error(
          "termination",
          "owned roots cleanup failed",
          failures,
        );
    },
  };
}
export type CheckpointRegistry = ReturnType<typeof createCheckpointRegistry>;
