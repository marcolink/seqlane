import { resolve } from "node:path";

import * as core from "@actions/core";
import {
  adoptDetachedProcess,
  assertDirectory,
  spawnDetached,
  terminateProcessGroup,
  waitForHttpHealth,
  type DetachedProcess,
} from "@seqlane/action-service-lifecycle";

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
  const hostname = core.getInput("hostname") || "127.0.0.1";
  const port = core.getInput("port") || "4096";
  const executable = core.getInput("executable") || "opencode";
  const timeoutSeconds = Number(
    core.getInput("startup-timeout-seconds") || "30",
  );
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("startup-timeout-seconds must be a positive integer");
  }

  await assertDirectory(workingDirectory);
  const url = `http://${hostname}:${port}`;
  const logPath = runnerTempPath("opencode.log");
  const service = await spawnDetached({
    command: executable,
    args: ["serve", "--hostname", hostname, "--port", port, "--print-logs"],
    cwd: workingDirectory,
    env: process.env,
    logPath,
    anchorPath: processAnchorPath(),
  });

  await saveProcessState(service);

  try {
    await waitForHttpHealth(`${url}/global/health`, timeoutSeconds * 1_000);
  } catch (error) {
    try {
      await terminateProcessGroup(service.pid, service.identity);
    } catch (cleanupError) {
      core.warning(
        `OpenCode startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }

  core.setOutput("url", url);
  core.setOutput("log-path", logPath);
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
