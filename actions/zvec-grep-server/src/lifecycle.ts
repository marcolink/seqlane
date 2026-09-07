import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptDetachedProcess,
  spawnDetached,
  terminateProcessGroup,
  type DetachedProcess,
} from "@seqlane/action-service-lifecycle";
import { assertDirectory } from "./filesystem.js";
import { buildZvecCommandPlan } from "./commands.js";
import {
  runCommand,
  runReadinessCommand,
  waitForCommandHealth,
} from "./readiness.js";

export interface ZvecGrepLifecycleInput {
  readonly packageManager: string;
  readonly packageSpec: string;
  readonly projectDirectory: string;
  readonly listen: string;
  readonly home: string;
  readonly embedding: string;
  readonly maxFilesize: string;
  readonly additionalGlobs: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly logPath: string;
  readonly timeoutMilliseconds: number;
}

export interface ZvecGrepLifecycleHooks {
  readonly saveState: (name: string, value: string) => void;
  readonly warning: (message: string) => void;
}

export interface ZvecGrepLifecycleDependencies {
  readonly assertDirectory: typeof assertDirectory;
  readonly runCommand: typeof runCommand;
  readonly runReadinessCommand: typeof runReadinessCommand;
  readonly waitForCommandHealth: typeof waitForCommandHealth;
  readonly spawnDetached: typeof spawnDetached;
  readonly adoptDetachedProcess: typeof adoptDetachedProcess;
  readonly terminateProcessGroup: typeof terminateProcessGroup;
}

const defaultDependencies: ZvecGrepLifecycleDependencies = {
  assertDirectory,
  runCommand,
  runReadinessCommand,
  waitForCommandHealth,
  spawnDetached,
  adoptDetachedProcess,
  terminateProcessGroup,
};

export function processAnchorPath(): string {
  return fileURLToPath(new URL("../process-anchor.js", import.meta.url));
}

export function packageExecutionDirectory(): string {
  return dirname(processAnchorPath());
}

async function saveProcessState(
  service: DetachedProcess,
  hooks: ZvecGrepLifecycleHooks,
  dependencies: ZvecGrepLifecycleDependencies,
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
        {
          pid: service.sentinelPid,
          identity: service.sentinelIdentity,
        },
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

export async function runZvecGrepLifecycle(
  input: ZvecGrepLifecycleInput,
  hooks: ZvecGrepLifecycleHooks,
  dependencies: ZvecGrepLifecycleDependencies = defaultDependencies,
): Promise<void> {
  await dependencies.assertDirectory(input.projectDirectory);

  const [resolveCommand, indexCommand, serverCommand, readinessCommand] =
    buildZvecCommandPlan({
      packageSpec: input.packageSpec,
      projectDirectory: input.projectDirectory,
      listen: input.listen,
      home: input.home,
      indexOptions: {
        embedding: input.embedding,
        maxFilesize: input.maxFilesize,
        additionalGlobs: input.additionalGlobs,
      },
    });
  const commandCwd = packageExecutionDirectory();
  const anchorPath = processAnchorPath();

  await dependencies.runCommand({
    command: input.packageManager,
    args: resolveCommand.args,
    cwd: commandCwd,
    env: input.environment,
  });

  await dependencies.runCommand({
    command: input.packageManager,
    args: indexCommand.args,
    cwd: commandCwd,
    env: input.environment,
  });

  const service = await dependencies.spawnDetached({
    command: input.packageManager,
    args: [...serverCommand.args],
    cwd: commandCwd,
    env: input.environment,
    logPath: input.logPath,
    anchorPath,
  });

  await saveProcessState(service, hooks, dependencies);

  try {
    await dependencies.waitForCommandHealth(
      () =>
        dependencies.runReadinessCommand({
          command: input.packageManager,
          args: [...readinessCommand.args],
          cwd: commandCwd,
          env: input.environment,
        }),
      input.timeoutMilliseconds,
      "zvec-grep",
    );
  } catch (error) {
    try {
      await dependencies.terminateProcessGroup(service.pid, service.identity, {
        pid: service.sentinelPid,
        identity: service.sentinelIdentity,
      });
    } catch (cleanupError) {
      hooks.warning(
        `zvec-grep startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}
