import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptDetachedProcess,
  spawnDetached,
  terminateProcessGroup,
  type DetachedProcess,
} from "@seqlane/action-service-lifecycle";
import { assertDirectory } from "./filesystem.js";
import { buildRipwireArguments, buildRipwireEnvironment } from "./commands.js";
import { checkMcpInitialize, waitForMcpHealth } from "./readiness.js";
import type { RipwireConfig } from "./config.js";

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
  readonly checkMcpInitialize: typeof checkMcpInitialize;
  readonly waitForMcpHealth: typeof waitForMcpHealth;
}

const defaultDependencies: RipwireLifecycleDependencies = {
  assertDirectory,
  spawnDetached,
  adoptDetachedProcess,
  terminateProcessGroup,
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
    try {
      const stopped = await dependencies.terminateProcessGroup(
        service.pid,
        service.identity,
        { pid: service.sentinelPid, identity: service.sentinelIdentity },
      );
      if (!stopped) {
        hooks.warning(
          `Process group ${service.pid} could not be verified during cleanup`,
        );
      }
    } catch (cleanupError) {
      hooks.warning(
        `Startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

async function cleanup(
  service: DetachedProcess,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies,
): Promise<void> {
  try {
    await dependencies.terminateProcessGroup(service.pid, service.identity, {
      pid: service.sentinelPid,
      identity: service.sentinelIdentity,
    });
  } catch (error) {
    hooks.warning(
      `Ripwire startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runRipwireLifecycle(
  input: RipwireLifecycleInput,
  hooks: RipwireLifecycleHooks,
  dependencies: RipwireLifecycleDependencies = defaultDependencies,
): Promise<void> {
  await dependencies.assertDirectory(input.config.workingDirectory);
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
      () =>
        dependencies.checkMcpInitialize(
          input.config.mcpUrl,
          input.config.mcpToken,
        ),
      input.config.startupTimeoutSeconds * 1_000,
    );
  } catch (error) {
    await cleanup(service, hooks, dependencies);
    throw error;
  }
}
