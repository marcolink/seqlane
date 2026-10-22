import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { Effect } from "effect";
import type * as Scope from "effect/Scope";

import { SpawnDetachedError, ServiceLifecycleError } from "./errors.js";
import {
  readProcessIdentity,
  waitForProcessGroupExit,
} from "./process-identity.js";
import {
  anchorMessageSchema,
  processIdentitySchema,
  type DetachedProcessOwnership,
  type ProcessIdentity,
} from "./schemas.js";
import { terminateProcessGroup } from "./termination.js";

export { SpawnDetachedError };
export type { DetachedProcessOwnership, ProcessIdentity };

export interface DetachedProcess {
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly sentinelPid: number;
  readonly sentinelIdentity: ProcessIdentity;
  readonly anchor: ChildProcess;
}

export interface SpawnDetachedOptions {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
  readonly anchorPath: string;
}

interface OwnedLifecycle {
  cleanupStarted: boolean;
  handoffComplete: boolean;
  adoptionAcknowledged: boolean;
  cleanupSucceeded: boolean | undefined;
  ownership: DetachedProcessOwnership | undefined;
  anchor: ChildProcess | undefined;
  anchorExited: boolean;
  anchorClosed: boolean;
}

const lifecycleState = new WeakMap<DetachedProcess, OwnedLifecycle>();

function waitForSpawn(child: ChildProcess) {
  return Effect.callback<void, Error>((resume, signal) => {
    const finish = (effect: Effect.Effect<void, Error>) => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resume(effect);
    };
    const onSpawn = () => finish(Effect.void);
    const onError = (error: Error) => finish(Effect.fail(error));
    const onAbort = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAnchorClose(
  child: ChildProcess,
  state: OwnedLifecycle,
  timeoutMilliseconds: number,
) {
  if (state.anchorExited || state.anchorClosed) return Effect.succeed(true);
  const closed = Effect.callback<void, never>((resume, signal) => {
    const finish = () => {
      child.off("exit", onExit);
      child.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      resume(Effect.void);
    };
    const onExit = () => {
      state.anchorExited = true;
      finish();
    };
    const onClose = () => {
      state.anchorClosed = true;
      finish();
    };
    const onAbort = () => {
      child.off("exit", onExit);
      child.off("close", onClose);
    };
    child.once("exit", onExit);
    child.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (state.anchorExited || state.anchorClosed) finish();
  });
  return Effect.timeoutOption(closed, timeoutMilliseconds).pipe(
    Effect.map((result) => result._tag === "Some"),
  );
}

type AnchorReady =
  | { readonly sentinelPid: number }
  | { readonly error: string; readonly sentinelPid?: number };

function waitForAnchorReady(child: ChildProcess) {
  return Effect.callback<AnchorReady, Error>((resume, signal) => {
    const finish = (effect: Effect.Effect<AnchorReady, Error>) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      child.off("disconnect", onDisconnect);
      signal.removeEventListener("abort", onAbort);
      resume(effect);
    };
    const onMessage = (value: unknown) => {
      const message = anchorMessageSchema.safeParse(value);
      if (!message.success)
        return finish(
          Effect.fail(
            new Error("Process anchor sent malformed readiness data"),
          ),
        );
      if (message.data.type === "ready")
        finish(Effect.succeed({ sentinelPid: message.data.sentinelPid }));
      else if (message.data.type === "error")
        finish(
          Effect.succeed({
            error: message.data.message,
            ...(message.data.sentinelPid
              ? { sentinelPid: message.data.sentinelPid }
              : {}),
          }),
        );
    };
    const onExit = (code: number | null, signalValue: NodeJS.Signals | null) =>
      finish(
        Effect.fail(
          new Error(
            `Process anchor exited before readiness (code=${String(code)}, signal=${String(signalValue)})`,
          ),
        ),
      );
    const onError = (error: Error) => finish(Effect.fail(error));
    const onDisconnect = () =>
      finish(
        Effect.fail(
          new Error("Process anchor IPC disconnected before readiness"),
        ),
      );
    const onAbort = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      child.off("disconnect", onDisconnect);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    child.once("disconnect", onDisconnect);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function adoptAndWaitForAck(child: ChildProcess) {
  return Effect.callback<void, Error>((resume, signal) => {
    if (!child.connected || typeof child.send !== "function") {
      resume(Effect.fail(new Error("Process anchor IPC is not connected")));
      return;
    }
    let settled = false;
    const finish = (effect: Effect.Effect<void, Error>) => {
      if (settled) return;
      settled = true;
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resume(effect);
    };
    const onMessage = (value: unknown) => {
      const parsed = anchorMessageSchema.safeParse(value);
      if (!parsed.success)
        return finish(
          Effect.fail(new Error("Process anchor sent malformed adoption data")),
        );
      if (parsed.data.type === "adopted") finish(Effect.void);
      else if (parsed.data.type === "error")
        finish(Effect.fail(new Error(parsed.data.message)));
    };
    const onDisconnect = () =>
      finish(
        Effect.fail(
          new Error("Process anchor IPC disconnected during adoption"),
        ),
      );
    const onError = (error: Error) => finish(Effect.fail(error));
    const onAbort = () => {
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
      child.off("error", onError);
    };
    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    child.send({ type: "adopt" }, (error) => {
      if (error) finish(Effect.fail(error));
    });
  });
}

function cleanup(
  service:
    | Pick<
        DetachedProcess,
        "pid" | "identity" | "sentinelPid" | "sentinelIdentity"
      >
    | undefined,
  child: ChildProcess | undefined,
  state: OwnedLifecycle,
) {
  return Effect.suspend(() => {
    if (state.handoffComplete || state.cleanupStarted) return Effect.void;
    state.cleanupStarted = true;
    const ownership = service
      ? {
          pid: service.pid,
          identity: service.identity,
          sentinel: {
            pid: service.sentinelPid,
            identity: service.sentinelIdentity,
          },
        }
      : state.ownership;
    if (ownership) {
      return terminateProcessGroup(
        ownership.pid,
        ownership.identity,
        ownership.sentinel,
      ).pipe(
        Effect.tap((succeeded) =>
          Effect.sync(() => {
            state.cleanupSucceeded = succeeded;
            if (!succeeded)
              process.stderr.write(
                "Could not confirm anchored service cleanup; ownership remains uncertain\n",
              );
          }),
        ),
        Effect.catch((cause) =>
          Effect.sync(() => {
            state.cleanupSucceeded = false;
            process.stderr.write(
              `Could not confirm anchored service cleanup: ${cause instanceof Error ? cause.message : String(cause)}\n`,
            );
          }),
        ),
      );
    }
    if (!child)
      return Effect.sync(() => {
        state.cleanupSucceeded = true;
      });
    return Effect.gen(function* () {
      if (child.connected) {
        try {
          child.disconnect();
        } catch {
          // The child may have disconnected between the check and call.
        }
      }
      let closed = yield* waitForAnchorClose(child, state, 2_000);
      if (!closed) {
        child.kill("SIGKILL");
        closed = yield* waitForAnchorClose(child, state, 2_000);
      }
      const groupStopped =
        closed && child.pid !== undefined
          ? yield* waitForProcessGroupExit(child.pid, 2_000).pipe(
              Effect.catch(() => Effect.succeed(false)),
            )
          : closed;
      state.cleanupSucceeded = groupStopped;
      if (!groupStopped)
        process.stderr.write(
          "Could not confirm process anchor group exit; cleanup remains uncertain\n",
        );
    });
  });
}

function start(options: SpawnDetachedOptions, state: OwnedLifecycle) {
  return Effect.gen(function* () {
    if (process.platform !== "linux" && process.platform !== "darwin")
      return yield* Effect.fail(
        new Error(`Process identity is unsupported on ${process.platform}`),
      );
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(options.logPath), { recursive: true }),
      catch: (cause) => cause,
    });
    const log = yield* Effect.try({
      try: () => openSync(options.logPath, "a"),
      catch: (cause) => cause,
    });
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => {
        try {
          const processAnchor = spawn(
            process.execPath,
            [options.anchorPath, options.command, JSON.stringify(options.args)],
            {
              cwd: options.cwd,
              env: options.env,
              detached: true,
              stdio: ["ignore", log, log, "ipc"],
              windowsHide: true,
            },
          );
          state.anchor = processAnchor;
          processAnchor.once("exit", () => {
            state.anchorExited = true;
          });
          processAnchor.once("close", () => {
            state.anchorClosed = true;
          });
          return processAnchor;
        } finally {
          closeSync(log);
        }
      }),
      (processAnchor) => cleanup(undefined, processAnchor, state),
    );
    yield* waitForSpawn(child).pipe(Effect.timeout("5 seconds"));
    const pid = child.pid;
    if (!pid || !Number.isInteger(pid) || pid < 1)
      return yield* Effect.fail(
        new Error("Could not determine the process anchor PID"),
      );
    const identity = yield* readProcessIdentity(pid);
    if (!identity || identity.processGroupId !== pid)
      return yield* Effect.fail(
        new Error("Could not verify process anchor identity"),
      );
    state.ownership = { pid, identity };
    const anchorReady = yield* waitForAnchorReady(child).pipe(
      Effect.timeout("5 seconds"),
    );
    if ("error" in anchorReady) {
      if (anchorReady.sentinelPid) {
        const sentinelIdentity = yield* readProcessIdentity(
          anchorReady.sentinelPid,
        );
        if (sentinelIdentity?.processGroupId === identity.processGroupId) {
          state.ownership = {
            pid,
            identity,
            sentinel: {
              pid: anchorReady.sentinelPid,
              identity: sentinelIdentity,
            },
          };
        }
      }
      return yield* Effect.fail(new Error(anchorReady.error));
    }
    const sentinelPid = anchorReady.sentinelPid;
    const sentinelIdentity = yield* readProcessIdentity(sentinelPid);
    const parsedIdentity = processIdentitySchema.safeParse(sentinelIdentity);
    if (
      !parsedIdentity.success ||
      parsedIdentity.data.processGroupId !== identity.processGroupId
    ) {
      return yield* Effect.fail(
        new Error(
          "Could not verify sentinel identity in the anchored process group",
        ),
      );
    }
    const service = {
      pid,
      identity,
      sentinelPid,
      sentinelIdentity: parsedIdentity.data,
      anchor: child,
    } satisfies DetachedProcess;
    state.ownership = {
      pid,
      identity,
      sentinel: { pid: sentinelPid, identity: parsedIdentity.data },
    };
    lifecycleState.set(service, state);
    return service;
  }).pipe(
    Effect.catch((cause) => {
      const hasVerifiedOwnership = state.ownership !== undefined;
      const cleanupEffect = state.anchor
        ? cleanup(undefined, state.anchor, state)
        : Effect.succeed(undefined);
      return cleanupEffect.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            Effect.fail(
              new SpawnDetachedError(
                options.command,
                cause,
                hasVerifiedOwnership
                  ? false
                  : (state.cleanupSucceeded ?? false),
                state.ownership,
              ),
            ),
          ),
        ),
      );
    }),
  );
}

export function spawnDetached(
  options: SpawnDetachedOptions,
): Effect.Effect<DetachedProcess, SpawnDetachedError, Scope.Scope> {
  return Effect.suspend(() => {
    const state: OwnedLifecycle = {
      cleanupStarted: false,
      handoffComplete: false,
      adoptionAcknowledged: false,
      cleanupSucceeded: undefined,
      ownership: undefined,
      anchor: undefined,
      anchorExited: false,
      anchorClosed: false,
    };
    return start(options, state).pipe(
      Effect.tap((service) =>
        Effect.acquireRelease(Effect.succeed(service), () =>
          cleanup(service, service.anchor, state),
        ),
      ),
    );
  });
}

export function adoptDetachedProcess(
  service: DetachedProcess,
): Effect.Effect<void, ServiceLifecycleError> {
  return Effect.gen(function* () {
    const state = lifecycleState.get(service);
    if (!state)
      return yield* Effect.fail(
        new ServiceLifecycleError(
          "Detached service has no active lifecycle scope",
          new Error("Unknown service ownership"),
        ),
      );
    yield* adoptAndWaitForAck(service.anchor).pipe(Effect.timeout("1 second"));
    yield* Effect.sync(() => {
      if (service.anchor.connected) service.anchor.disconnect();
      service.anchor.unref();
      const state = lifecycleState.get(service);
      if (state) state.adoptionAcknowledged = true;
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServiceLifecycleError(
          "Could not adopt the anchored service",
          cause,
        ),
    ),
  );
}

export function completeDetachedProcessHandoff(
  service: DetachedProcess,
): Effect.Effect<void, ServiceLifecycleError> {
  return Effect.gen(function* () {
    const state = lifecycleState.get(service);
    if (!state || !state.ownership || !state.adoptionAcknowledged)
      return yield* Effect.fail(
        new ServiceLifecycleError(
          "Cannot hand off a service before resident adoption",
          new Error("Service ownership or adoption acknowledgment is missing"),
        ),
      );
    state.handoffComplete = true;
  });
}

export function cleanupDetachedProcess(
  service: DetachedProcess,
): Effect.Effect<boolean, ServiceLifecycleError> {
  const state = lifecycleState.get(service);
  if (!state)
    return Effect.fail(
      new ServiceLifecycleError(
        "Detached service has no active lifecycle scope",
        new Error("Unknown service ownership"),
      ),
    );
  return cleanup(service, service.anchor, state).pipe(
    Effect.map(() => state.cleanupSucceeded ?? false),
  );
}

export { terminateProcessGroup };
