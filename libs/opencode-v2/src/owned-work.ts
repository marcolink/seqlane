import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { requestOptions, type V2Client } from "./client.js";
import {
  activeSchema,
  sessionPageSchema,
  sessionSchema,
  shellPageSchema,
} from "./schemas.js";
import { OpenCodeV2Error } from "./errors.js";

const shellOwnerSchema = z.object({ sessionID: z.string().min(1) });

export async function ownedSessions(
  client: V2Client,
  root: string,
  workspace: string,
  signal: AbortSignal,
): Promise<Set<string>> {
  const ids = new Set([root]);
  for (const parentID of ids) {
    const session = sessionSchema.parse(
      await client.session.get({ sessionID: parentID }, requestOptions(signal)),
    );
    if (session.location.directory !== workspace)
      throw new OpenCodeV2Error(
        "protocol",
        "owned session changed its workspace",
      );
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const result = sessionPageSchema.parse(
        await client.session.list(
          { parentID, limit: 100, ...(cursor === undefined ? {} : { cursor }) },
          requestOptions(signal),
        ),
      );
      let addedSession = false;
      for (const child of result.data) {
        if (
          child.parentID !== parentID ||
          child.location.directory !== workspace
        )
          throw new OpenCodeV2Error("protocol", "invalid native child session");
        if (!ids.has(child.id)) addedSession = true;
        ids.add(child.id);
      }
      if (ids.size > 128)
        throw new OpenCodeV2Error(
          "limit",
          "native session tree exceeded 128 sessions",
        );
      cursor = result.cursor.next ?? undefined;
      if (cursor !== undefined && !addedSession)
        throw new OpenCodeV2Error(
          "protocol",
          "child session page did not add a session",
        );
      if (cursor !== undefined && cursors.has(cursor))
        throw new OpenCodeV2Error(
          "protocol",
          "child session cursor did not advance",
        );
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
  }
  return ids;
}

export async function runningWork(
  client: V2Client,
  ids: ReadonlySet<string>,
  workspace: string,
  signal: AbortSignal,
) {
  const active = activeSchema.parse(
    await client.session.active(requestOptions(signal)),
  );
  const shells = shellPageSchema.parse(
    await client.shell.list(
      { location: { directory: workspace } },
      requestOptions(signal),
    ),
  ).data;
  const ownedShells: string[] = [];
  for (const shell of shells) {
    if (shell.status !== "running") continue;
    const owner = shellOwnerSchema.safeParse(shell.metadata);
    if (!owner.success)
      throw new OpenCodeV2Error(
        "termination",
        "cannot establish ownership of a running native shell",
      );
    if (ids.has(owner.data.sessionID)) ownedShells.push(shell.id);
  }
  return { active: [...ids].some((id) => id in active), shells: ownedShells };
}

/** Stop only this session tree, never the external service or unrelated jobs. */
export async function terminateOwnedSession(
  client: V2Client,
  root: string,
  workspace: string,
): Promise<void> {
  const signal = AbortSignal.timeout(5_000);
  const ids = new Set<string>();
  while (true) {
    const discovered = await ownedSessions(client, root, workspace, signal);
    const added = [...discovered].filter((id) => !ids.has(id));
    for (const id of added) ids.add(id);
    await Promise.all(
      added.map((sessionID) =>
        client.session.interrupt(
          { sessionID, resume: false },
          requestOptions(signal),
        ),
      ),
    );
    const work = await runningWork(client, ids, workspace, signal);
    await Promise.all(
      work.shells.map((id) =>
        client.shell.remove(
          { id, location: { directory: workspace } },
          requestOptions(signal),
        ),
      ),
    );
    if (!work.active && work.shells.length === 0) {
      const latest = await ownedSessions(client, root, workspace, signal);
      if (![...latest].some((id) => !ids.has(id))) break;
    }
    await setTimeout(50, undefined, { signal });
  }
  await client.session.remove({ sessionID: root }, requestOptions(signal));
}
