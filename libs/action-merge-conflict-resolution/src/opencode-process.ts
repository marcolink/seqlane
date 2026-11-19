import { spawn, type ChildProcess } from "node:child_process";
import { Effect, Scope } from "effect";

import {
  captureOwnedProcessIdentity,
  observeChildLifecycle,
  confirmOwnedProcessGroupStopped,
  terminateOwnedProcess,
  type OwnedProcessIdentity,
} from "@seqlane/agent-adapter/private/owned-process";
import { ActionResolutionError } from "./errors.js";

export interface OpenCodeProcessOptions {
  readonly start?: (
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly detached: boolean;
    },
  ) => ChildProcess;
  readonly healthcheck?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface OpenCodeProcessState {
  safeToDelete: boolean;
  cleanupFailure?: unknown;
  cleanupFailurePresent?: boolean;
}

function runtimeError(message: string, cause?: unknown): ActionResolutionError {
  return new ActionResolutionError("agent", "AGENT_FAILED", message, cause);
}

const promise = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause });

function defaultHealthcheck(url: string) {
  return Effect.gen(function* () {
    const response = yield* promise((signal) => fetch(url, { signal }));
    yield* promise(() => response.body?.cancel() ?? Promise.resolve());
    return response.ok;
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function waitForOpenCodeReady(
  child: ChildProcess,
  healthcheck: Effect.Effect<boolean, unknown>,
  timeoutMs: number,
  pollIntervalMs: number,
) {
  const poll = Effect.gen(function* () {
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return yield* Effect.fail(
          runtimeError("OpenCode exited before becoming ready.", {
            processId: child.pid,
          }),
        );
      }
      if (yield* healthcheck) return;
      yield* Effect.sleep(`${pollIntervalMs} millis`);
    }
  });
  return poll.pipe(
    Effect.timeoutOption(`${timeoutMs} millis`),
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : Effect.fail(
            runtimeError("OpenCode did not become ready before the timeout."),
          ),
    ),
  );
}

export interface OwnedOpenCodeChild {
  readonly child: ChildProcess;
  readonly lifecycle: ReturnType<typeof observeChildLifecycle>;
  identity?: OwnedProcessIdentity;
}

interface OpenCodeChildCommand {
  readonly executable: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly start?: OpenCodeProcessOptions["start"];
}

export function waitForOpenCodeChildClose(owned: OwnedOpenCodeChild) {
  return owned.lifecycle.exit.pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );
}

function stopOwnedRuntimeProcess(owned: OwnedOpenCodeChild) {
  return Effect.gen(function* () {
    if (owned.identity === undefined) {
      // A live native handle still owns its leader. Never signal an unknown
      // surviving group after that leader has gone.
      if (yield* owned.lifecycle.isRunning) {
        owned.child.kill("SIGTERM");
        const graceful = yield* waitForOpenCodeChildClose(owned).pipe(
          Effect.timeoutOption("500 millis"),
        );
        if (graceful._tag === "None") {
          owned.child.kill("SIGKILL");
          yield* waitForOpenCodeChildClose(owned).pipe(
            Effect.timeout("1 second"),
          );
        }
      }
      if (
        !(yield* promise(() =>
          confirmOwnedProcessGroupStopped(owned.child.pid ?? 0),
        ))
      )
        return yield* Effect.fail(
          new Error(
            "OpenCode process identity was not confirmed; its process tree may still be running.",
          ),
        );
      return;
    }
    const identity = owned.identity;
    const graceful = yield* promise(() =>
      terminateOwnedProcess(identity, "SIGTERM"),
    );
    if (
      !graceful.confirmed &&
      !(yield* promise(() => terminateOwnedProcess(identity, "SIGKILL")))
        .confirmed
    )
      return yield* Effect.fail(
        new Error("Could not confirm that the OpenCode process tree stopped."),
      );
    yield* waitForOpenCodeChildClose(owned).pipe(Effect.timeout("1 second"));
  }).pipe(Effect.timeout("5 seconds"));
}

export function acquireOpenCodeChild(
  command: OpenCodeChildCommand,
  state: OpenCodeProcessState,
): Effect.Effect<OwnedOpenCodeChild, unknown, Scope.Scope> {
  const acquire = Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(
      Effect.sync((): OwnedOpenCodeChild => {
        const child =
          command.start === undefined
            ? spawn(command.executable, command.args, {
                cwd: command.cwd,
                env: command.env,
                detached: process.platform !== "win32",
                stdio: "ignore",
                windowsHide: true,
              })
            : command.start(command.executable, command.args, {
                cwd: command.cwd,
                env: command.env,
                detached: process.platform !== "win32",
              });
        return { child, lifecycle: observeChildLifecycle(child) };
      }),
      (owned) =>
        stopOwnedRuntimeProcess(owned).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              state.safeToDelete = false;
              state.cleanupFailure = cause;
              state.cleanupFailurePresent = true;
            }),
          ),
        ),
    );
    yield* Effect.uninterruptible(
      owned.lifecycle.spawned.pipe(Effect.timeout("5 seconds")),
    );
    const child = owned.child;
    owned.identity = yield* Effect.uninterruptible(
      promise(async () => {
        try {
          return await captureOwnedProcessIdentity(child.pid ?? 0);
        } catch (cause) {
          if (await confirmOwnedProcessGroupStopped(child.pid ?? 0))
            return undefined;
          throw cause;
        }
      }),
    );
    return owned;
  });
  return acquire;
}

export function startOpenCodeProcess(
  executable: string,
  workspace: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  readinessUrl: string,
  options: OpenCodeProcessOptions,
  state: OpenCodeProcessState,
): Effect.Effect<ChildProcess, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const owned = yield* acquireOpenCodeChild(
      {
        executable,
        cwd: workspace,
        args,
        env,
        ...(options.start === undefined ? {} : { start: options.start }),
      },
      state,
    );
    const check = options.healthcheck;
    const healthcheck =
      check === undefined
        ? defaultHealthcheck(readinessUrl)
        : promise((signal) => check(readinessUrl, signal)).pipe(
            Effect.timeout("2 seconds"),
          );
    yield* waitForOpenCodeReady(
      owned.child,
      healthcheck,
      options.readinessTimeoutMs ?? 120_000,
      options.pollIntervalMs ?? 1_000,
    );
    return owned.child;
  });
}
