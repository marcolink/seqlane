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

const maximumOutputBytes = 8 * 1024 * 1024;
export const commandIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause });

export interface CommandOwnershipState {
  uncertainty?: { readonly cause: unknown };
  output?: { readonly stdout: () => string; readonly stderr: () => string };
}

export interface OwnedCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Byte caps apply to each stream. Keep complete chunks before the cap. */
function capture<E>(stream: Stream.Stream<Uint8Array, E>) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const read = Stream.runForEach(stream, (chunk) =>
    Effect.suspend(() => {
      bytes += chunk.byteLength;
      if (bytes > maximumOutputBytes)
        return Effect.fail(new Error("Client output exceeds 8 MiB."));
      chunks.push(chunk);
      return Effect.void;
    }),
  );
  return {
    read,
    text: () => {
      const text = Buffer.concat(chunks).toString("utf8");
      // UTF-8 replacement characters can expand an incomplete byte sequence.
      return Buffer.byteLength(text) <= maximumOutputBytes
        ? text
        : new TextDecoder().decode(
            Buffer.from(text).subarray(0, maximumOutputBytes),
            { stream: true },
          );
    },
  };
}

/** Signal only the acquired leader when its birth identity is unavailable. */
function stopLeader(
  child: ChildProcess,
  lifecycle: ReturnType<typeof observeChildLifecycle>,
) {
  return Effect.gen(function* () {
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
  });
}

function stopOwnedCommand(
  child: ChildProcess,
  lifecycle: ReturnType<typeof observeChildLifecycle>,
  identity: OwnedProcessIdentity | undefined,
) {
  return Effect.gen(function* () {
    if (child.pid === undefined) return;
    if (process.platform === "win32")
      return yield* stopLeader(child, lifecycle);
    if (identity === undefined) yield* stopLeader(child, lifecycle);
    if (yield* commandIo(() => confirmOwnedProcessGroupStopped(child.pid ?? 0)))
      return;
    if (identity === undefined)
      return yield* Effect.fail(
        new Error(
          "Client exited with an active process group and no verified identity.",
        ),
      );
    const owned = identity;
    const graceful = yield* commandIo(() =>
      terminateOwnedProcess(owned, "SIGTERM"),
    );
    if (
      !graceful.confirmed &&
      !(yield* commandIo(() => terminateOwnedProcess(owned, "SIGKILL")))
        .confirmed
    )
      return yield* Effect.fail(
        new Error("Could not confirm that the client process tree stopped."),
      );
  });
}

/** Native streams/scopes; Node launch avoids the spawner's unverified exit-time group signal. */
export function ownedCommandEffect(
  request: OwnedCommandRequest,
  state: CommandOwnershipState,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const ownership: { identity?: OwnedProcessIdentity } = {};
      const owned = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const child = spawn(request.executable, request.args, {
            cwd: request.cwd,
            env: request.env,
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { child, lifecycle: observeChildLifecycle(child) };
        }),
        ({ child, lifecycle }) =>
          stopOwnedCommand(child, lifecycle, ownership.identity).pipe(
            Effect.timeout("5 seconds"),
            Effect.catch((cause) =>
              Effect.sync(() => {
                state.uncertainty = { cause };
              }),
            ),
          ),
      );
      const { child, lifecycle: acquired } = owned;
      yield* Effect.uninterruptible(
        acquired.spawned.pipe(Effect.timeout("5 seconds")),
      );
      const stdout = capture(
        NodeStream.fromReadable({
          evaluate: () => child.stdout,
          onError: (cause) => cause,
        }),
      );
      const stderr = capture(
        NodeStream.fromReadable({
          evaluate: () => child.stderr,
          onError: (cause) => cause,
        }),
      );
      state.output = { stdout: stdout.text, stderr: stderr.text };
      // Start readers before identity I/O: Node drains unread pipes after exit.
      const result = yield* Effect.all(
        {
          stdout: stdout.read,
          stderr: stderr.read,
          identity: Effect.uninterruptible(
            commandIo(async () => {
              try {
                ownership.identity = await captureOwnedProcessIdentity(
                  child.pid ?? 0,
                );
              } catch (cause) {
                if (await confirmOwnedProcessGroupStopped(child.pid ?? 0))
                  return;
                throw cause;
              }
            }),
          ),
          exit: acquired.exit,
        },
        { concurrency: "unbounded" },
      );
      return {
        exitCode: result.exit.code ?? 1,
        stdout: stdout.text(),
        stderr: stderr.text(),
      };
    }),
  );
}
