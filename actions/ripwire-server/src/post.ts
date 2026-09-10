import * as core from "@actions/core";
import { terminateProcessGroup } from "@seqlane/action-service-lifecycle";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { removeInstallDirectory } from "./release.js";
import {
  CLEANUP_ONLY_STATE_KEY,
  parseCleanupOnlyState,
  parseServiceState,
} from "./state.js";

export async function run(): Promise<void> {
  const installDirectory = core.getState("install-directory");
  const serviceState = parseServiceState(core.getState("service-state"));
  const cleanupOnly = parseCleanupOnlyState(
    core.getState(CLEANUP_ONLY_STATE_KEY),
  );
  if (!serviceState) {
    if (installDirectory && cleanupOnly) {
      try {
        await removeInstallDirectory(
          installDirectory,
          process.env.RUNNER_TEMP ?? "/tmp",
        );
      } catch (error) {
        core.warning(
          `Ripwire install cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (installDirectory) {
      core.warning(
        "Ripwire service state is missing or invalid; retaining the install directory",
      );
    }
    return;
  }

  let terminated = false;
  try {
    terminated = await terminateProcessGroup(
      serviceState.pid,
      serviceState.identity,
      serviceState.sentinel,
    );
    if (!terminated) {
      core.warning(
        `Ripwire process group ${serviceState.pid} did not stop cleanly`,
      );
    }
  } catch (error) {
    core.warning(
      `Ripwire process cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (terminated && installDirectory) {
    try {
      await removeInstallDirectory(
        installDirectory,
        process.env.RUNNER_TEMP ?? "/tmp",
      );
    } catch (error) {
      core.warning(
        `Ripwire install cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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
