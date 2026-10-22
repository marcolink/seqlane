import { Effect } from "effect";
import type { DockerCommandRequest } from "./lockfile-port.js";
import {
  commandIo,
  ownedCommandEffect,
  type CommandOwnershipState,
} from "./command-process.js";

const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "TMPDIR"]);
export type DockerOwnershipState = CommandOwnershipState;
export const dockerIo = commandIo;

/** Own the real client tree; container ownership is handled separately. */
export function dockerCliEffect(
  request: DockerCommandRequest,
  state: DockerOwnershipState,
) {
  return ownedCommandEffect(
    {
      ...request,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...Object.fromEntries(
          Object.entries(request.env).filter(
            ([key, value]) =>
              allowedEnvironment.has(key) && value !== undefined,
          ),
        ),
      },
    },
    state,
  ).pipe(Effect.timeout(request.timeoutMs ?? 300_000));
}
