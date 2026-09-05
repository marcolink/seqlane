import {
  assertDirectory,
  getInput,
  getRunnerTempPath,
  persistProcessState,
  reportFailure,
  setOutput,
  spawnDetached,
  terminateProcessGroup,
  waitForHttpHealth,
} from "../lib/lifecycle.js";

async function main() {
  const workingDirectory = getInput("working-directory");
  const hostname = getInput("hostname", "127.0.0.1");
  const port = getInput("port", "4096");
  const executable = getInput("executable", "opencode");
  const timeoutSeconds = Number(getInput("startup-timeout-seconds", "30"));
  if (!workingDirectory) throw new Error("working-directory is required");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("startup-timeout-seconds must be a positive integer");
  }

  await assertDirectory(workingDirectory);
  const url = `http://${hostname}:${port}`;
  const logPath = getRunnerTempPath("opencode.log");
  const service = await spawnDetached({
    command: executable,
    args: ["serve", "--hostname", hostname, "--port", port, "--print-logs"],
    cwd: workingDirectory,
    env: process.env,
    logPath,
  });

  await persistProcessState(service);

  try {
    await waitForHttpHealth(`${url}/global/health`, timeoutSeconds * 1_000);
  } catch (error) {
    try {
      await terminateProcessGroup(service.pid, service.identity);
    } catch (cleanupError) {
      console.warn(`OpenCode startup cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }

  await setOutput("url", url);
  await setOutput("log-path", logPath);
}

main().catch(reportFailure);
