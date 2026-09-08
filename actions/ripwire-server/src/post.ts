import * as core from "@actions/core";
import { terminateProcessGroup } from "@seqlane/action-service-lifecycle";

export async function run(): Promise<void> {
  const pid = core.getState("pid");
  if (!pid) return;
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
  if (!(await terminateProcessGroup(pid, identity, sentinel))) {
    core.warning(`Ripwire process group ${pid} did not stop cleanly`);
  }
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
