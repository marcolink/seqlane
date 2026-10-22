import { Effect } from "effect";

import {
  acquireOpenCodeChild,
  waitForOpenCodeChildClose,
  type OpenCodeProcessState,
} from "./opencode-process.js";

export function extractOpenCodeArchive(
  archivePath: string,
  directory: string,
  state: OpenCodeProcessState,
  command = {
    executable: "tar",
    args: [
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      directory,
    ],
  },
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const owned = yield* acquireOpenCodeChild(
        { ...command, cwd: directory, env: { PATH: process.env.PATH ?? "" } },
        state,
      );
      yield* waitForOpenCodeChildClose(owned).pipe(
        Effect.timeout("60 seconds"),
      );
      if (owned.child.exitCode !== 0) {
        return yield* Effect.fail(
          new Error("The OpenCode archive could not be extracted.", {
            cause: {
              exitCode: owned.child.exitCode,
              signalCode: owned.child.signalCode,
            },
          }),
        );
      }
    }),
  ).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        state.cleanupFailurePresent === true
          ? Effect.fail(state.cleanupFailure)
          : Effect.void,
      ),
    ),
  );
}
