import * as core from "@actions/core";
import { terminateProcessGroup } from "@seqlane/action-service-lifecycle";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { removeInstallDirectory } from "./release.js";

export async function run(): Promise<void> {
  const pid = core.getState("pid");
  let terminated = true;
  if (pid) {
    const identity = {
      processGroupId: core.getState("process-group-id"),
      processStartTime: core.getState("process-start-time"),
    };
    const sentinel = {
      pid: core.getState("sentinel-pid"),
      identity: {
        processGroupId: core.getState("sentinel-process-group-id"),
        processStartTime: core.getState("sentinel-process-start-time"),
      },
    };
    try {
      terminated = await terminateProcessGroup(pid, identity, sentinel);
      if (!terminated) {
        core.warning(`Ripwire process group ${pid} did not stop cleanly`);
      }
    } catch (error) {
      terminated = false;
      core.warning(
        `Ripwire process cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const installDirectory = core.getState("install-directory");
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
