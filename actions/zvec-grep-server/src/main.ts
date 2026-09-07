import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "@actions/core";
import {
  adoptDetachedProcess,
  spawnDetached,
  terminateProcessGroup,
  type DetachedProcess,
} from "@seqlane/action-service-lifecycle";
import { assertDirectory } from "./filesystem.js";
import { buildZvecCommandPlan, buildZvecEnvironment } from "./commands.js";
import {
  mcpUrl,
  runCommand,
  runReadinessCommand,
  waitForCommandHealth,
} from "./readiness.js";

function runnerTempPath(fileName: string): string {
  return resolve(process.env.RUNNER_TEMP ?? "/tmp", fileName);
}

export function processAnchorPath(): string {
  return fileURLToPath(new URL("../process-anchor.js", import.meta.url));
}

async function saveProcessState(service: DetachedProcess): Promise<void> {
  try {
    core.saveState("pid", String(service.pid));
    core.saveState("process-group-id", String(service.identity.processGroupId));
    core.saveState("process-start-time", service.identity.processStartTime);
    core.saveState("sentinel-pid", String(service.sentinelPid));
    core.saveState(
      "sentinel-process-group-id",
      String(service.sentinelIdentity.processGroupId),
    );
    core.saveState(
      "sentinel-process-start-time",
      service.sentinelIdentity.processStartTime,
    );
    await adoptDetachedProcess(service);
  } catch (error) {
    try {
      const stopped = await terminateProcessGroup(
        service.pid,
        service.identity,
        {
          pid: service.sentinelPid,
          identity: service.sentinelIdentity,
        },
      );
      if (!stopped) {
        core.warning(
          `Process group ${service.pid} could not be verified during cleanup`,
        );
      }
    } catch (cleanupError) {
      core.warning(
        `Startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

export async function run(): Promise<void> {
  const workingDirectory = core.getInput("working-directory", {
    required: true,
  });
  const version = core.getInput("version") || "0.2.1";
  const listen = core.getInput("listen") || "127.0.0.1:7999";
  const packageManager = core.getInput("package-manager") || "pnpm";
  const home = core.getInput("home") || runnerTempPath("zvec-grep");
  const embedding = core.getInput("embedding") || "local/potion-code-16m-v2";
  const maxFilesize = core.getInput("max-filesize") || "1M";
  const additionalGlobs = core.getMultilineInput("glob");
  const modelCache = core.getBooleanInput("model-cache")
    ? runnerTempPath("zvec-grep-model-cache")
    : undefined;
  const timeoutSeconds = Number(
    core.getInput("startup-timeout-seconds") || "30",
  );
  if (!version) throw new Error("version is required");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("startup-timeout-seconds must be a positive integer");
  }

  await assertDirectory(workingDirectory);
  const env = buildZvecEnvironment(process.env, home, modelCache);
  const packageSpec = `@zvec/zvec-grep@${version}`;
  const [resolveCommand, indexCommand, serverCommand, readinessCommand] =
    buildZvecCommandPlan({
      packageSpec,
      projectDirectory: workingDirectory,
      listen,
      home,
      indexOptions: {
        embedding,
        maxFilesize,
        additionalGlobs,
      },
    });
  const logPath = runnerTempPath("zvec-grep.log");

  await runCommand({
    command: packageManager,
    args: resolveCommand.args,
    cwd: workingDirectory,
    env,
  });

  await runCommand({
    command: packageManager,
    args: indexCommand.args,
    cwd: workingDirectory,
    env,
  });

  const service = await spawnDetached({
    command: packageManager,
    args: [...serverCommand.args],
    cwd: workingDirectory,
    env,
    logPath,
    anchorPath: processAnchorPath(),
  });

  await saveProcessState(service);

  try {
    await waitForCommandHealth(
      () =>
        runReadinessCommand({
          command: packageManager,
          args: [...readinessCommand.args],
          cwd: workingDirectory,
          env,
        }),
      timeoutSeconds * 1_000,
      "zvec-grep",
    );
  } catch (error) {
    try {
      await terminateProcessGroup(service.pid, service.identity, {
        pid: service.sentinelPid,
        identity: service.sentinelIdentity,
      });
    } catch (cleanupError) {
      core.warning(
        `zvec-grep startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }

  core.setOutput("mcp-url", mcpUrl(listen));
  core.setOutput("log-path", logPath);
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
