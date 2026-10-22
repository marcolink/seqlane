import { spawn, type ChildProcess } from "node:child_process";
import { Effect, Scope } from "effect";

import {
  captureOwnedProcessIdentity,
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

function defaultStart(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly detached: boolean;
  },
): ChildProcess {
  return spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: "ignore",
    windowsHide: true,
  });
}

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

function waitForSpawn(child: ChildProcess) {
  return promise(
    (signal) =>
      new Promise<void>((resolveSpawn, rejectSpawn) => {
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const onSpawn = () => {
          cleanup();
          resolveSpawn();
        };
        const onError = (cause: unknown) => {
          cleanup();
          rejectSpawn(cause);
        };
        const onAbort = () => {
          cleanup();
          rejectSpawn(signal.reason);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
  );
}

function waitForOpenCodeReady(
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
  healthcheck: Effect.Effect<boolean, unknown>,
  timeoutMs: number,
  pollIntervalMs: number,
) {
  const poll = Effect.gen(function* () {
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return yield* Effect.fail(
          runtimeError("OpenCode exited before becoming ready.", {
            exitCode: child.exitCode,
            signalCode: child.signalCode,
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
  closed: boolean;
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
  return Effect.callback<void>((resume, signal) => {
    if (owned.closed) return resume(Effect.void);
    const cleanup = () => {
      owned.child.off("close", onClose);
      signal.removeEventListener("abort", cleanup);
    };
    const onClose = () => {
      cleanup();
      resume(Effect.void);
    };
    owned.child.once("close", onClose);
    signal.addEventListener("abort", cleanup, { once: true });
  });
}

function stopOwnedRuntimeProcess(owned: OwnedOpenCodeChild) {
  return Effect.gen(function* () {
    if (owned.identity === undefined) {
      if (!owned.closed) {
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
      const processId = owned.child.pid;
      if (
        processId !== undefined &&
        !(yield* promise(() => confirmOwnedProcessGroupStopped(processId)))
      ) {
        return yield* Effect.fail(
          new Error(
            "OpenCode process identity was not confirmed; its process tree may still be running.",
          ),
        );
      }
      return;
    }
    const identity = owned.identity;
    const graceful = yield* promise(() =>
      terminateOwnedProcess(identity, "SIGTERM"),
    );
    if (!graceful.confirmed) {
      const forced = yield* promise(() =>
        terminateOwnedProcess(identity, "SIGKILL"),
      );
      if (!forced.confirmed) {
        return yield* Effect.fail(
          new Error(
            "Could not confirm that the OpenCode process tree stopped.",
          ),
        );
      }
    }
    yield* waitForOpenCodeChildClose(owned).pipe(Effect.timeout("1 second"));
  });
}

export function acquireOpenCodeChild(
  command: OpenCodeChildCommand,
  state: OpenCodeProcessState,
): Effect.Effect<OwnedOpenCodeChild, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(
      Effect.sync((): OwnedOpenCodeChild => {
        const child = (command.start ?? defaultStart)(
          command.executable,
          command.args,
          {
            cwd: command.cwd,
            env: command.env,
            detached: true,
          },
        );
        const owned: OwnedOpenCodeChild = { child, closed: false };
        child.once("close", () => {
          owned.closed = true;
        });
        return owned;
      }),
      (runtime) =>
        stopOwnedRuntimeProcess(runtime).pipe(
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
      waitForSpawn(owned.child).pipe(Effect.timeout("5 seconds")),
    );
    if (owned.child.pid === undefined) {
      return yield* Effect.fail(
        new Error("OpenCode did not report a process ID."),
      );
    }
    const processId = owned.child.pid;
    owned.identity = yield* Effect.uninterruptible(
      promise(() => captureOwnedProcessIdentity(processId)).pipe(
        Effect.catch((cause) =>
          owned.closed ? Effect.succeed(undefined) : Effect.fail(cause),
        ),
      ),
    );
    return owned;
  });
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
