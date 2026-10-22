import { Effect } from "effect";
import {
  adoptDetachedProcess,
  completeDetachedProcessHandoff,
  detachedProcessOwnershipSchema,
  spawnDetached,
  type DetachedProcess,
  type SpawnDetachedOptions,
} from "@seqlane/action-service-lifecycle";
import { assertDirectory } from "./filesystem.js";
import { waitForHttpHealth } from "./readiness.js";

export interface OpenCodeLifecycleInput {
  readonly workingDirectory: string;
  readonly executable: string;
  readonly hostname: string;
  readonly port: string;
  readonly logPath: string;
  readonly startupTimeoutMilliseconds: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly anchorPath: string;
}

export interface OpenCodeLifecycleHooks {
  readonly saveState: (name: string, value: string) => void;
}

function persistOwnership(
  service: DetachedProcess,
  hooks: OpenCodeLifecycleHooks,
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
      new Error("OpenCode process ownership did not pass validation", {
        cause: parsed.error,
      }),
    );
  }

  const { pid, identity, sentinel } = parsed.data;
  if (!sentinel) {
    return Effect.fail(new Error("OpenCode sentinel ownership is missing"));
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
      new Error("OpenCode process ownership could not be saved", { cause }),
  });
}

export function startOpenCodeEffect(
  input: OpenCodeLifecycleInput,
  hooks: OpenCodeLifecycleHooks,
): Effect.Effect<void, Error> {
  const url = `http://${input.hostname}:${input.port}`;
  const options: SpawnDetachedOptions = {
    command: input.executable,
    args: [
      "serve",
      "--hostname",
      input.hostname,
      "--port",
      input.port,
      "--print-logs",
    ],
    cwd: input.workingDirectory,
    env: input.environment,
    logPath: input.logPath,
    anchorPath: input.anchorPath,
  };

  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => assertDirectory(input.workingDirectory),
        catch: (cause) =>
          new Error("OpenCode working directory is invalid", { cause }),
      });
      const service = yield* spawnDetached(options);
      yield* persistOwnership(service, hooks);
      yield* adoptDetachedProcess(service);
      yield* waitForHttpHealth(
        `${url}/global/health`,
        input.startupTimeoutMilliseconds,
      );
      yield* completeDetachedProcessHandoff(service);
    }),
  );
}
