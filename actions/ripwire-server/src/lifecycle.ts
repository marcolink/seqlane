import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Cause, Effect } from "effect";
import {
  adoptDetachedProcess,
  cleanupDetachedProcess,
  completeDetachedProcessHandoff,
  detachedProcessOwnershipSchema,
  readProcessIdentity,
  spawnDetached,
  SpawnDetachedError,
  type DetachedProcess,
  type DetachedProcessOwnership,
} from "@seqlane/action-service-lifecycle";
import { assertDirectory } from "./filesystem.js";
import { buildRipwireArguments, buildRipwireEnvironment } from "./commands.js";
import { checkMcpInitializeEffect, waitForMcpHealth } from "./readiness.js";
import type { RipwireConfig } from "./config.js";
import { assertListenAvailable } from "./port.js";
import { assertListenOwnedByProcess } from "./socket-ownership.js";
import { serializeServiceState, serviceStateSchema } from "./state.js";

export interface RipwireLifecycleInput {
  readonly config: RipwireConfig;
  readonly binaryDirectory: string;
  readonly logPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionToken: string;
}

export interface RipwireLifecycleHooks {
  readonly saveState: (name: string, value: string) => void;
  readonly warning: (message: string) => void;
}

export interface RipwireLifecycleDependencies {
  readonly assertDirectory: typeof assertDirectory;
  readonly spawnDetached: typeof spawnDetached;
  readonly adoptDetachedProcess: typeof adoptDetachedProcess;
  readonly cleanupDetachedProcess: typeof cleanupDetachedProcess;
  readonly completeDetachedProcessHandoff: typeof completeDetachedProcessHandoff;
  readonly assertListenAvailable: typeof assertListenAvailable;
  readonly assertListenOwnedByProcess: typeof assertListenOwnedByProcess;
  readonly readProcessIdentity: typeof readProcessIdentity;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly checkMcpInitialize: typeof checkMcpInitializeEffect;
  readonly waitForMcpHealth: typeof waitForMcpHealth;
}

export class RipwireStartupError extends Error {
  readonly cleanupSucceeded: boolean;
  readonly ownership: DetachedProcessOwnership | undefined;

  constructor(
    cause: unknown,
    cleanupSucceeded: boolean,
    ownership?: DetachedProcessOwnership,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RipwireStartupError";
    this.cleanupSucceeded = cleanupSucceeded;
    this.ownership = ownership;
  }
}

const defaultDependencies: RipwireLifecycleDependencies = {
  assertDirectory,
  spawnDetached,
  adoptDetachedProcess,
  cleanupDetachedProcess,
  completeDetachedProcessHandoff,
  assertListenAvailable,
  assertListenOwnedByProcess,
  readProcessIdentity,
  isProcessAlive,
  checkMcpInitialize: checkMcpInitializeEffect,
  waitForMcpHealth,
};

export function processAnchorPath(): string {
  return fileURLToPath(new URL("../dist/process-anchor.js", import.meta.url));
}

export function packageExecutionDirectory(): string {
  return dirname(processAnchorPath());
}

function persistOwnership(
  service: DetachedProcess,
  hooks: RipwireLifecycleHooks,
): Effect.Effect<void, Error> {
  const parsed = detachedProcessOwnershipSchema.safeParse({
    pid: service.pid,
    identity: service.identity,
    sentinel: {
      pid: service.sentinelPid,
      identity: service.sentinelIdentity,
    },
  });
  if (!parsed.success) {
    return Effect.fail(
      new Error("Ripwire process ownership did not pass validation", {
        cause: parsed.error,
      }),
    );
  }
  const withRequiredSentinel = serviceStateSchema.safeParse(parsed.data);
  if (!withRequiredSentinel.success || !withRequiredSentinel.data.sentinel) {
    return Effect.fail(
      new Error("Ripwire sentinel ownership did not pass validation", {
        cause: withRequiredSentinel.success
          ? undefined
          : withRequiredSentinel.error,
      }),
    );
  }

  return Effect.try({
    try: () =>
      hooks.saveState(
        "service-state",
        serializeServiceState(withRequiredSentinel.data),
      ),
    catch: (cause) =>
      new Error("Ripwire process ownership could not be saved", { cause }),
  });
}

function persistAmbiguousSpawnOwnership(
  ownership: DetachedProcessOwnership | undefined,
  hooks: RipwireLifecycleHooks,
): Effect.Effect<void, never> {
  if (!ownership) return Effect.void;
  const parsed = detachedProcessOwnershipSchema.safeParse(ownership);
  if (!parsed.success) return Effect.void;
  return Effect.try({
    try: () =>
      hooks.saveState("service-state", serializeServiceState(parsed.data)),
    catch: (cause) =>
      new Error("Ripwire ambiguous ownership could not be saved", { cause }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.sync(() =>
        hooks.warning(
          `Ripwire ambiguous spawn state persistence failed: ${cause.message}`,
        ),
      ),
    ),
  );
}

function cleanupAfterStartupFailure(
  service: DetachedProcess,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies,
  cause: unknown,
): Effect.Effect<never, RipwireStartupError> {
  return dependencies.cleanupDetachedProcess(service).pipe(
    Effect.map((cleanupSucceeded) => {
      if (!cleanupSucceeded) {
        hooks.warning(
          `Ripwire process group ${service.pid} could not be verified during startup cleanup`,
        );
      }
      return new RipwireStartupError(cause, cleanupSucceeded);
    }),
    Effect.catch((cleanupError) =>
      Effect.sync(() =>
        hooks.warning(
          `Ripwire startup cleanup failed: ${cleanupError.message}`,
        ),
      ).pipe(Effect.as(new RipwireStartupError(cause, false))),
    ),
    Effect.flatMap((error) => Effect.fail(error)),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function verifyServiceIdentity(
  service: DetachedProcess,
  dependencies: RipwireLifecycleDependencies,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (!dependencies.isProcessAlive(service.pid)) {
      return yield* Effect.fail(
        new Error("Ripwire process exited before startup completed"),
      );
    }
    const currentIdentity = yield* dependencies.readProcessIdentity(
      service.pid,
    );
    if (
      !currentIdentity ||
      currentIdentity.processGroupId !== service.identity.processGroupId ||
      currentIdentity.processStartTime !== service.identity.processStartTime
    ) {
      return yield* Effect.fail(
        new Error("Ripwire process identity changed before startup completed"),
      );
    }
  });
}

export function runRipwireLifecycle(
  input: RipwireLifecycleInput,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies = defaultDependencies,
): Effect.Effect<void, Error | Cause.TimeoutError> {
  const environment = buildRipwireEnvironment(
    input.environment,
    input.binaryDirectory,
    input.sessionToken,
  );

  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => dependencies.assertDirectory(input.config.workingDirectory),
        catch: (cause) =>
          new Error("Ripwire working directory is invalid", { cause }),
      });
      yield* Effect.tryPromise({
        try: () => dependencies.assertListenAvailable(input.config.listen),
        catch: (cause) =>
          new Error("Ripwire listen address is unavailable", { cause }),
      });

      const options = {
        command: "ripwire",
        args: buildRipwireArguments(input.config),
        cwd: input.binaryDirectory,
        env: environment,
        logPath: input.logPath,
        anchorPath: processAnchorPath(),
      };
      const service = yield* dependencies.spawnDetached(options).pipe(
        Effect.catch((cause) => {
          const spawnError =
            cause instanceof SpawnDetachedError ? cause : undefined;
          const cleanupSucceeded = spawnError?.cleanupSucceeded ?? false;
          const ownership = spawnError?.ownership;
          return persistAmbiguousSpawnOwnership(ownership, hooks).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new RipwireStartupError(
                  cause,
                  cleanupSucceeded,
                  !cleanupSucceeded ? ownership : undefined,
                ),
              ),
            ),
          );
        }),
      );

      const startup = Effect.gen(function* () {
        yield* persistOwnership(service, hooks);
        yield* dependencies.adoptDetachedProcess(service);
        yield* dependencies.waitForMcpHealth(
          (remainingMilliseconds) =>
            dependencies.checkMcpInitialize(
              input.config.mcpUrl,
              input.sessionToken,
              remainingMilliseconds,
              (probeTimeoutMilliseconds) =>
                Effect.tryPromise({
                  try: (signal) =>
                    dependencies.assertListenOwnedByProcess(
                      input.config.listen,
                      service,
                      (pid) =>
                        Effect.runPromise(
                          dependencies.readProcessIdentity(pid),
                          { signal },
                        ),
                      process.platform,
                      undefined,
                      probeTimeoutMilliseconds,
                      signal,
                    ),
                  catch: (cause) =>
                    new Error("Ripwire listener ownership check failed", {
                      cause,
                    }),
                }),
            ),
          input.config.startupTimeoutSeconds * 1_000,
        );
        yield* verifyServiceIdentity(service, dependencies);
        yield* dependencies.completeDetachedProcessHandoff(service);
      });

      yield* startup.pipe(
        Effect.catch((cause) =>
          cleanupAfterStartupFailure(service, hooks, dependencies, cause),
        ),
      );
    }),
  );
}
