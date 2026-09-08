import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptDetachedProcess,
  readProcessIdentity,
  spawnDetached,
  SpawnDetachedError,
  terminateProcessGroup,
  type DetachedProcess,
  type DetachedProcessOwnership,
  type ProcessIdentity,
} from "@seqlane/action-service-lifecycle";
import { assertDirectory } from "./filesystem.js";
import { buildRipwireArguments, buildRipwireEnvironment } from "./commands.js";
import { checkMcpInitialize, waitForMcpHealth } from "./readiness.js";
import type { RipwireConfig } from "./config.js";
import { assertListenAvailable } from "./port.js";
import { assertListenOwnedByProcess } from "./socket-ownership.js";
import { serializeServiceState, type ServiceState } from "./state.js";

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
  readonly terminateProcessGroup: typeof terminateProcessGroup;
  readonly assertListenAvailable: typeof assertListenAvailable;
  readonly assertListenOwnedByProcess: typeof assertListenOwnedByProcess;
  readonly readProcessIdentity: typeof readProcessIdentity;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly checkMcpInitialize: typeof checkMcpInitialize;
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
  terminateProcessGroup,
  assertListenAvailable,
  assertListenOwnedByProcess,
  readProcessIdentity,
  isProcessAlive,
  checkMcpInitialize,
  waitForMcpHealth,
};

export function processAnchorPath(): string {
  return fileURLToPath(new URL("../process-anchor.js", import.meta.url));
}

export function packageExecutionDirectory(): string {
  return dirname(processAnchorPath());
}

async function saveProcessState(
  service: DetachedProcess,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies,
): Promise<void> {
  try {
    const state: ServiceState = {
      pid: service.pid,
      identity: service.identity,
      sentinel: {
        pid: service.sentinelPid,
        identity: service.sentinelIdentity,
      },
    };
    hooks.saveState("service-state", serializeServiceState(state));
    await dependencies.adoptDetachedProcess(service);
  } catch (error) {
    const cleanupSucceeded = await cleanupService(service, hooks, dependencies);
    throw new RipwireStartupError(error, cleanupSucceeded);
  }
}

export async function cleanupService(
  service: DetachedProcess,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies,
): Promise<boolean> {
  try {
    const stopped = await dependencies.terminateProcessGroup(
      service.pid,
      service.identity,
      {
        pid: service.sentinelPid,
        identity: service.sentinelIdentity,
      },
    );
    if (!stopped) {
      hooks.warning(
        `Ripwire process group ${service.pid} could not be verified during cleanup`,
      );
    }
    return stopped;
  } catch (error) {
    hooks.warning(
      `Ripwire startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifyServiceIdentity(
  service: DetachedProcess,
  dependencies: RipwireLifecycleDependencies,
): Promise<void> {
  if (!dependencies.isProcessAlive(service.pid)) {
    throw new Error("Ripwire process exited before startup completed");
  }
  const currentIdentity: ProcessIdentity | undefined =
    await dependencies.readProcessIdentity(service.pid);
  if (
    !currentIdentity ||
    currentIdentity.processGroupId !== service.identity.processGroupId ||
    currentIdentity.processStartTime !== service.identity.processStartTime
  ) {
    throw new Error(
      "Ripwire process identity changed before startup completed",
    );
  }
}

export async function runRipwireLifecycle(
  input: RipwireLifecycleInput,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies = defaultDependencies,
): Promise<void> {
  await dependencies.assertDirectory(input.config.workingDirectory);
  await dependencies.assertListenAvailable(input.config.listen);
  const environment = buildRipwireEnvironment(
    input.environment,
    input.binaryDirectory,
    input.sessionToken,
  );
  let service: DetachedProcess;
  try {
    service = await dependencies.spawnDetached({
      command: "ripwire",
      args: buildRipwireArguments(input.config),
      cwd: input.binaryDirectory,
      env: environment,
      logPath: input.logPath,
      anchorPath: processAnchorPath(),
    });
  } catch (error) {
    // No validated DetachedProcess was returned. Preserve the shared spawn
    // cleanup result instead of inventing an identity or retrying termination.
    const spawnError = error instanceof SpawnDetachedError ? error : undefined;
    const cleanupSucceeded = spawnError?.cleanupSucceeded ?? false;
    if (!cleanupSucceeded && spawnError?.ownership) {
      try {
        hooks.saveState(
          "service-state",
          serializeServiceState(spawnError.ownership),
        );
      } catch (stateError) {
        hooks.warning(
          `Ripwire ambiguous spawn state persistence failed: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
        );
      }
    }
    throw new RipwireStartupError(
      error,
      cleanupSucceeded,
      !cleanupSucceeded ? spawnError?.ownership : undefined,
    );
  }

  await saveProcessState(service, hooks, dependencies);
  try {
    await dependencies.waitForMcpHealth(
      (remainingMilliseconds) =>
        dependencies.checkMcpInitialize(
          input.config.mcpUrl,
          input.sessionToken,
          remainingMilliseconds,
          fetch,
          (remainingMilliseconds) =>
            dependencies.assertListenOwnedByProcess(
              input.config.listen,
              service,
              dependencies.readProcessIdentity,
              remainingMilliseconds,
            ),
        ),
      input.config.startupTimeoutSeconds * 1_000,
    );
    await verifyServiceIdentity(service, dependencies);
  } catch (error) {
    const cleanupSucceeded = await cleanupService(service, hooks, dependencies);
    throw new RipwireStartupError(error, cleanupSucceeded);
  }
}
