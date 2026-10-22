import { spawn, type ChildProcess } from "node:child_process";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { Effect, Stream } from "effect";
import {
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  observeChildLifecycle,
  terminateOwnedProcess,
  type OwnedProcessIdentity,
} from "@seqlane/agent-adapter/private/owned-process";
import type { StartOpenCodeServiceOptions } from "./service.js";
import { OpenCodeServiceCleanupError } from "./errors.js";

function stopOwnedProcess(
  child: ChildProcess,
  identity: OwnedProcessIdentity | undefined,
  timeoutMs: number,
) {
  return Effect.gen(function* () {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      const lifecycle = observeChildLifecycle(child);
      if (!(yield* lifecycle.isRunning)) return;
      child.kill("SIGTERM");
      const graceful = yield* lifecycle.exit.pipe(
        Effect.timeoutOption(timeoutMs),
      );
      if (graceful._tag === "Some") return;
      child.kill("SIGKILL");
      yield* lifecycle.exit.pipe(Effect.timeout(Math.min(timeoutMs, 1_000)));
      return;
    }
    if (
      yield* Effect.tryPromise(() =>
        confirmOwnedProcessGroupStopped(child.pid ?? 0),
      )
    )
      return;
    if (identity === undefined) {
      const lifecycle = observeChildLifecycle(child);
      if (yield* lifecycle.isRunning) {
        child.kill("SIGTERM");
        const graceful = yield* lifecycle.exit.pipe(
          Effect.timeoutOption("500 millis"),
        );
        if (graceful._tag === "None") {
          child.kill("SIGKILL");
          yield* lifecycle.exit.pipe(Effect.timeout("1 second"));
        }
      }
      if (
        yield* Effect.tryPromise(() =>
          confirmOwnedProcessGroupStopped(child.pid ?? 0),
        )
      )
        return;
      return yield* Effect.fail(
        new OpenCodeServiceCleanupError(
          "Owned OpenCode process identity is unavailable",
        ),
      );
    }
    const graceful = yield* Effect.tryPromise(() =>
      terminateOwnedProcess(identity, "SIGTERM"),
    );
    if (!graceful.confirmed) {
      const forced = yield* Effect.tryPromise(() =>
        terminateOwnedProcess(identity, "SIGKILL"),
      );
      if (!forced.confirmed)
        return yield* Effect.fail(
          new OpenCodeServiceCleanupError(
            "Owned OpenCode process did not exit after SIGKILL",
          ),
        );
    }
  }).pipe(Effect.timeout(timeoutMs + Math.min(timeoutMs, 1_000)));
}

/** Own only process acquisition, native log streams and verified shutdown. */
export function acquireOpenCodeServiceProcess(
  options: StartOpenCodeServiceOptions,
  settings: {
    readonly host: string;
    readonly port: number;
    readonly password: string;
    readonly shutdownTimeoutMs: number;
    readonly onOutput: (chunk: Buffer) => void;
    readonly onError: (cause: unknown) => void;
    readonly onCleanupFailure: (cause: unknown) => void;
  },
) {
  let identity: OwnedProcessIdentity | undefined;
  return Effect.gen(function* () {
    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = (options.spawn ?? spawn)(
          "opencode",
          [
            "serve",
            `--hostname=${settings.host}`,
            `--port=${settings.port}`,
            "--print-logs",
          ],
          {
            cwd: options.workspace,
            detached: process.platform !== "win32",
            env: {
              ...process.env,
              OPENCODE_SERVER_USERNAME: "seqlane",
              OPENCODE_SERVER_PASSWORD: settings.password,
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        return { child, lifecycle: observeChildLifecycle(child) };
      }),
      ({ child }) =>
        stopOwnedProcess(child, identity, settings.shutdownTimeoutMs).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              settings.onCleanupFailure(cause);
            }),
          ),
        ),
    );
    const { child, lifecycle } = acquired;
    yield* Effect.uninterruptible(
      lifecycle.spawned.pipe(Effect.timeout("5 seconds")),
    );
    identity = yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: async () => {
          try {
            return await captureOwnedProcessIdentity(child.pid ?? 0);
          } catch (cause) {
            if (await confirmOwnedProcessGroupStopped(child.pid ?? 0))
              return undefined;
            throw cause;
          }
        },
        catch: (cause) => cause,
      }),
    );
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null)
      return yield* Effect.fail(
        new Error("OpenCode output pipes are unavailable"),
      );
    const logs = Stream.merge(
      NodeStream.fromReadable({
        evaluate: () => stdout,
        onError: (cause) => cause,
      }),
      NodeStream.fromReadable({
        evaluate: () => stderr,
        onError: (cause) => cause,
      }),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(logs, (chunk) =>
        Effect.sync(() => settings.onOutput(Buffer.from(chunk))),
      ).pipe(
        Effect.catch((cause) => Effect.sync(() => settings.onError(cause))),
      ),
    );
    return child;
  });
}
