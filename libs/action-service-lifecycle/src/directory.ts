import { Effect, FileSystem } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

/** Shared working-directory preflight for the service Actions. */
export function assertDirectory(directory: string): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const details = yield* fs.stat(directory);
    if (details.type !== "Directory") {
      return yield* Effect.fail(
        new Error(
          `Configured working directory is not a directory: ${directory}`,
        ),
      );
    }
  }).pipe(Effect.provide(NodeFileSystem.layer));
}
