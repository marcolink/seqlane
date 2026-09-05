import {
  getState,
  reportFailure,
  terminateProcessGroup,
} from "../lib/lifecycle.js";

async function cleanup() {
  const pid = getState("pid");
  if (!pid) return;
  const identity = {
    processGroupId: getState("process-group-id"),
    processStartTime: getState("process-start-time"),
  };
  if (!(await terminateProcessGroup(pid, identity))) {
    console.warn(`zvec-grep process group ${pid} did not stop cleanly`);
  }
}

cleanup().catch(reportFailure);
