import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Cause, Effect } from "effect";
import {
  adoptDetachedProcess,
  completeDetachedProcessHandoff,
  detachedProcessOwnershipSchema,
  spawnDetached,
  type DetachedProcess,
  type SpawnDetachedOptions,
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
  readonly completeDetachedProcessHandoff: typeof completeDetachedProcessHandoff;
}

const defaultDependencies: ZvecGrepLifecycleDependencies = {
  assertDirectory,
  runCommand,
  runReadinessCommand,
  waitForCommandHealth,
  spawnDetached,
  adoptDetachedProcess,
  completeDetachedProcessHandoff,
};

export function processAnchorPath(): string {
  return fileURLToPath(new URL("../dist/process-anchor.js", import.meta.url));
}

export function packageExecutionDirectory(): string {
  return dirname(processAnchorPath());
}

function persistOwnership(
  service: DetachedProcess,
  hooks: ZvecGrepLifecycleHooks,
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
      new Error("zvec-grep process ownership did not pass validation", {
        cause: parsed.error,
      }),
    );
  }

  const { pid, identity, sentinel } = parsed.data;
  if (!sentinel) {
    return Effect.fail(new Error("zvec-grep sentinel ownership is missing"));
  }

  return Effect.try({
    try: () => {
      hooks.saveState("pid", String(pid));
      hooks.saveState("process-group-id", String(identity.processGroupId));
      hooks.saveState("process-start-time", identity.processStartTime);
      hooks.saveState("sentinel-pid", String(sentinel.pid));
      hooks.saveState(
        "sentinel-process-group-id",
        String(sentinel.identity.processGroupId),
      );
      hooks.saveState(
        "sentinel-process-start-time",
        sentinel.identity.processStartTime,
      );
    },
    catch: (cause) =>
      new Error("zvec-grep process ownership could not be saved", { cause }),
  });
}

export function runZvecGrepLifecycle(
  input: ZvecGrepLifecycleInput,
  hooks: ZvecGrepLifecycleHooks,
  dependencies: ZvecGrepLifecycleDependencies = defaultDependencies,
): Effect.Effect<void, Error | Cause.TimeoutError> {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => dependencies.assertDirectory(input.projectDirectory),
        catch: (cause) =>
          new Error("zvec-grep project directory is invalid", { cause }),
      });

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
      const spawnOptions: SpawnDetachedOptions = {
        command: input.packageManager,
        args: [...serverCommand.args],
        cwd: commandCwd,
        env: input.environment,
        logPath: input.logPath,
        anchorPath: processAnchorPath(),
      };

      yield* dependencies.runCommand({
        command: input.packageManager,
        args: [...resolveCommand.args],
        cwd: commandCwd,
        env: input.environment,
      });
      yield* dependencies.runCommand({
        command: input.packageManager,
        args: [...indexCommand.args],
        cwd: commandCwd,
        env: input.environment,
      });

      const service = yield* dependencies.spawnDetached(spawnOptions);
      yield* persistOwnership(service, hooks);
      yield* dependencies.adoptDetachedProcess(service);
      yield* dependencies.waitForCommandHealth(
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
      yield* dependencies.completeDetachedProcessHandoff(service);
    }),
  );
}
