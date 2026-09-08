import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "@actions/core";
import { assertDirectory } from "./filesystem.js";
import { parseRipwireInputs } from "./config.js";
import { installRipwire, removeInstallDirectory } from "./release.js";
import { RipwireStartupError, runRipwireLifecycle } from "./lifecycle.js";
import { createSessionToken } from "./token.js";

function runnerTempPath(fileName: string): string {
  return resolve(process.env.RUNNER_TEMP ?? "/tmp", fileName);
}

export { packageExecutionDirectory } from "./lifecycle.js";
export { processAnchorPath } from "./lifecycle.js";

export async function run(): Promise<void> {
  const mcpTokenSeed = core.getInput("mcp-token") || undefined;
  const config = parseRipwireInputs({
    workingDirectory: core.getInput("working-directory", { required: true }),
    version: core.getInput("version") || undefined,
    listen: core.getInput("listen") || undefined,
    topK: core.getInput("top-k") || undefined,
    stableOrder: core.getInput("stable-order") || undefined,
    redact: core.getInput("redact") || undefined,
    mcpToken: mcpTokenSeed,
    allowRemoteEdits: core.getInput("allow-remote-edits") || undefined,
    startupTimeoutSeconds:
      core.getInput("startup-timeout-seconds") || undefined,
  });
  const sessionToken = createSessionToken(config.mcpToken);
  if (config.mcpToken) core.setSecret(config.mcpToken);
  core.setSecret(sessionToken);

  await assertDirectory(config.workingDirectory);
  const runnerTemp = process.env.RUNNER_TEMP ?? "/tmp";
  const logPath = runnerTempPath("ripwire.log");
  let install: Awaited<ReturnType<typeof installRipwire>> | undefined;
  try {
    install = await installRipwire({
      version: config.version,
      runnerTemp,
    });
    core.saveState("install-directory", install.binaryDirectory);
    core.addPath(install.binaryDirectory);
    await runRipwireLifecycle(
      {
        config,
        binaryDirectory: install.binaryDirectory,
        logPath,
        environment: process.env,
        sessionToken,
      },
      {
        saveState: core.saveState,
        warning: core.warning,
      },
    );
  } catch (error) {
    const cleanupSucceeded =
      error instanceof RipwireStartupError ? error.cleanupSucceeded : true;
    if (install && cleanupSucceeded) {
      try {
        await removeInstallDirectory(install.binaryDirectory, runnerTemp);
      } catch (cleanupError) {
        core.warning(
          `Ripwire install cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw error;
  }

  if (!install) throw new Error("Ripwire install did not complete");
  core.setOutput("mcp-url", config.mcpUrl);
  core.setOutput("log-path", logPath);
  core.setOutput("binary-path", install.binaryPath);
  core.setOutput("version", install.version);
  core.setOutput("mcp-token", sessionToken);
}

function isDirectEntry(): boolean {
  if (process.execArgv.includes("-e") || process.execArgv.includes("--eval")) {
    return false;
  }
  const entry = process.argv[1];
  if (!entry) return false;
  const entryPath = entry.startsWith("file:")
    ? fileURLToPath(entry)
    : resolve(entry);
  return entryPath === fileURLToPath(import.meta.url);
}

if (isDirectEntry()) {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
