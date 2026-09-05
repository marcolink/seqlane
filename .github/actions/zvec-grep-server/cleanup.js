import {
  getState,
  reportFailure,
  terminateProcessGroup,
} from "../lib/lifecycle.js";

async function cleanup() {
  const pid = getState("pid");
  if (!pid) return;
  if (!(await terminateProcessGroup(pid))) {
    console.warn(`zvec-grep process group ${pid} did not stop cleanly`);
  }
}

cleanup().catch(reportFailure);
