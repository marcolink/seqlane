import { resolve } from "node:path";

import * as core from "@actions/core";
import {
  adoptDetachedProcess,
  assertDirectory,
  runReadinessCommand,
  spawnDetached,
  terminateProcessGroup,
  waitForCommandHealth,
  type DetachedProcess,
} from "@seqlane/action-service-lifecycle";
import { buildReadinessArguments, mcpUrl } from "./readiness.js";

function runnerTempPath(fileName: string): string {
  return resolve(process.env.RUNNER_TEMP ?? "/tmp", fileName);
}

function processAnchorPath(): string {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  if (!actionPath) throw new Error("GITHUB_ACTION_PATH is required");
  return resolve(actionPath, "process-anchor.js");
}

async function saveProcessState(service: DetachedProcess): Promise<void> {
  try {
    core.saveState("pid", String(service.pid));
    core.saveState("process-group-id", String(service.identity.processGroupId));
    core.saveState("process-start-time", service.identity.processStartTime);
    await adoptDetachedProcess(service);
  } catch (error) {
    try {
      const stopped = await terminateProcessGroup(
        service.pid,
        service.identity,
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
  const modelCache =
    core.getInput("model-cache") || runnerTempPath("zvec-grep-model-cache");
  const timeoutSeconds = Number(
    core.getInput("startup-timeout-seconds") || "30",
  );
  if (!version) throw new Error("version is required");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("startup-timeout-seconds must be a positive integer");
  }

  await assertDirectory(workingDirectory);
  const env = {
    ...process.env,
    ZVEC_GREP_HOME: home,
    ZVEC_GREP_MODEL_CACHE: modelCache,
  };
  const packageSpec = `@zvec/zvec-grep@${version}`;
  const commandArgs = ["dlx", packageSpec, "server", "run", "--listen", listen];
  const logPath = runnerTempPath("zvec-grep.log");
  const service = await spawnDetached({
    command: packageManager,
    args: commandArgs,
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
          args: buildReadinessArguments(packageSpec, home),
          cwd: workingDirectory,
          env,
        }),
      timeoutSeconds * 1_000,
      "zvec-grep",
    );
  } catch (error) {
    try {
      await terminateProcessGroup(service.pid, service.identity);
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
