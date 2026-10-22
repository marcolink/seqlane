import { spawn, type ChildProcess } from "node:child_process";
import { Effect } from "effect";

import {
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  terminateOwnedProcess,
  type OwnedProcessIdentity,
} from "@seqlane/agent-adapter/private/owned-process";
import type { DockerCommandRequest } from "./lockfile-port.js";

const maximumOutputBytes = 8 * 1024 * 1024;
const closeDeadline = "2 seconds";
const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "TMPDIR"]);

export interface DockerOwnershipState {
  uncertainty?: { readonly cause: unknown };
}

interface DockerCliChild {
  readonly child: ChildProcess;
  readonly closed: Promise<{ readonly exitCode: number }>;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly overflowed: Promise<void>;
  identity?: OwnedProcessIdentity;
  overflow: boolean;
}

export const dockerIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause });

function startDockerCli(request: DockerCommandRequest): DockerCliChild {
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...Object.fromEntries(
        Object.entries(request.env).filter(
          ([key, value]) => allowedEnvironment.has(key) && value !== undefined,
        ),
      ),
    },
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<{ readonly exitCode: number }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1 }));
    },
  );
  void closed.catch(() => undefined);
  let notifyOverflow!: () => void;
  const overflowed = new Promise<void>((resolve) => {
    notifyOverflow = resolve;
  });
  const owned: DockerCliChild = {
    child,
    closed,
    stdout: [],
    stderr: [],
    overflow: false,
    overflowed,
  };
  const collect = (target: Buffer[]) => {
    let bytes = 0;
    return (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumOutputBytes) {
        owned.overflow = true;
        notifyOverflow();
        return;
      }
      target.push(buffer);
    };
  };
  child.stdout?.on("data", collect(owned.stdout));
  child.stderr?.on("data", collect(owned.stderr));
  return owned;
}

function stopDockerCli(owned: DockerCliChild) {
  return Effect.gen(function* () {
    const pid = owned.child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      if (owned.child.exitCode === null) owned.child.kill("SIGKILL");
    } else if (!(yield* dockerIo(() => confirmOwnedProcessGroupStopped(pid)))) {
      const identity = owned.identity;
      if (identity === undefined) {
        return yield* Effect.fail(
          new Error("Docker client identity is unavailable."),
        );
      }
      const graceful = yield* dockerIo(() =>
        terminateOwnedProcess(identity, "SIGTERM"),
      );
      if (!graceful.confirmed) {
        const forced = yield* dockerIo(() =>
          terminateOwnedProcess(identity, "SIGKILL"),
        );
        if (!forced.confirmed) {
          return yield* Effect.fail(
            new Error("Docker client termination is unconfirmed."),
          );
        }
      }
    }
    yield* dockerIo(() => owned.closed).pipe(Effect.timeout(closeDeadline));
  });
}

/** Own the real client tree; container ownership is handled separately. */
export function dockerCliEffect(
  request: DockerCommandRequest,
  state: DockerOwnershipState,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const owned = yield* Effect.acquireRelease(
        Effect.sync(() => startDockerCli(request)),
        (child) =>
          stopDockerCli(child).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                state.uncertainty = { cause };
              }),
            ),
          ),
      );
      const pid = owned.child.pid;
      if (pid !== undefined) {
        owned.identity = yield* dockerIo(() =>
          captureOwnedProcessIdentity(pid),
        ).pipe(
          Effect.catch((cause) =>
            owned.child.exitCode !== null
              ? Effect.succeed(undefined)
              : Effect.fail(cause),
          ),
        );
      }
      const result = yield* Effect.raceFirst(
        dockerIo(() => owned.closed),
        dockerIo(() => owned.overflowed).pipe(
          Effect.flatMap(() =>
            Effect.fail(new Error("Docker client output exceeds 8 MiB.")),
          ),
        ),
      );
      if (owned.overflow)
        return yield* Effect.fail(
          new Error("Docker client output exceeds 8 MiB."),
        );
      return {
        ...result,
        stdout: Buffer.concat(owned.stdout).toString("utf8"),
        stderr: Buffer.concat(owned.stderr).toString("utf8"),
      };
    }),
  ).pipe(Effect.timeout(request.timeoutMs ?? 300_000));
}
