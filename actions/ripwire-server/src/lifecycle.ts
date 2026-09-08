import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptDetachedProcess,
  readProcessIdentity,
  spawnDetached,
  terminateProcessGroup,
  type DetachedProcess,
  type ProcessIdentity,
} from "@seqlane/action-service-lifecycle";
import { assertDirectory } from "./filesystem.js";
import { buildRipwireArguments, buildRipwireEnvironment } from "./commands.js";
import { checkMcpInitialize, waitForMcpHealth } from "./readiness.js";
import type { RipwireConfig } from "./config.js";
import { assertListenAvailable } from "./port.js";

export interface RipwireLifecycleInput {
  readonly config: RipwireConfig;
  readonly binaryDirectory: string;
  readonly logPath: string;
  readonly environment: NodeJS.ProcessEnv;
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
  readonly readProcessIdentity: typeof readProcessIdentity;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly checkMcpInitialize: typeof checkMcpInitialize;
  readonly waitForMcpHealth: typeof waitForMcpHealth;
}

const defaultDependencies: RipwireLifecycleDependencies = {
  assertDirectory,
  spawnDetached,
  adoptDetachedProcess,
  terminateProcessGroup,
  assertListenAvailable,
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
    hooks.saveState("pid", String(service.pid));
    hooks.saveState(
      "process-group-id",
      String(service.identity.processGroupId),
    );
    hooks.saveState("process-start-time", service.identity.processStartTime);
    hooks.saveState("sentinel-pid", String(service.sentinelPid));
    hooks.saveState(
      "sentinel-process-group-id",
      String(service.sentinelIdentity.processGroupId),
    );
    hooks.saveState(
      "sentinel-process-start-time",
      service.sentinelIdentity.processStartTime,
    );
    await dependencies.adoptDetachedProcess(service);
  } catch (error) {
    await cleanupService(service, hooks, dependencies);
    throw error;
  }
}

async function cleanupService(
  service: DetachedProcess,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies,
): Promise<void> {
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
  } catch (error) {
    hooks.warning(
      `Ripwire startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    input.config.mcpToken,
  );
  const service = await dependencies.spawnDetached({
    command: "ripwire",
    args: buildRipwireArguments(input.config),
    cwd: input.binaryDirectory,
    env: environment,
    logPath: input.logPath,
    anchorPath: processAnchorPath(),
  });

  await saveProcessState(service, hooks, dependencies);
  try {
    await dependencies.waitForMcpHealth(
      (remainingMilliseconds) =>
        dependencies.checkMcpInitialize(
          input.config.mcpUrl,
          input.config.mcpToken,
          remainingMilliseconds,
        ),
      input.config.startupTimeoutSeconds * 1_000,
    );
    await verifyServiceIdentity(service, dependencies);
  } catch (error) {
    await cleanupService(service, hooks, dependencies);
    throw error;
  }
}
