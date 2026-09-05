import {
  assertDirectory,
  getInput,
  getRunnerTempPath,
  reportFailure,
  runReadinessCommand,
  saveState,
  setOutput,
  spawnDetached,
  terminateProcessGroup,
  waitForCommandHealth,
} from "../lib/lifecycle.js";

function mcpUrl(listen) {
  const parsed = new URL(`http://${listen}`);
  if (!parsed.hostname || !parsed.port) {
    throw new Error("listen must contain a hostname and port");
  }
  return `${parsed.origin}/mcp`;
}

async function main() {
  const workingDirectory = getInput("working-directory");
  const version = getInput("version", "0.2.1");
  const listen = getInput("listen", "127.0.0.1:7999");
  const packageManager = getInput("package-manager", "pnpm");
  const home = getInput("home", getRunnerTempPath("zvec-grep"));
  const modelCache = getInput(
    "model-cache",
    getRunnerTempPath("zvec-grep-model-cache"),
  );
  const timeoutSeconds = Number(getInput("startup-timeout-seconds", "30"));
  if (!workingDirectory) throw new Error("working-directory is required");
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
  const logPath = getRunnerTempPath("zvec-grep.log");
  const pid = await spawnDetached({
    command: packageManager,
    args: commandArgs,
    cwd: workingDirectory,
    env,
    logPath,
  });

  await saveState("pid", String(pid));
  await saveState("log-path", logPath);

  try {
    await waitForCommandHealth(
      () =>
        runReadinessCommand({
          command: packageManager,
          args: ["dlx", packageSpec, "server", "status", "--check-ready"],
          cwd: workingDirectory,
          env,
        }),
      timeoutSeconds * 1_000,
      "zvec-grep",
    );
  } catch (error) {
    try {
      await terminateProcessGroup(pid);
    } catch (cleanupError) {
      console.warn(`zvec-grep startup cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }

  await setOutput("mcp-url", mcpUrl(listen));
  await setOutput("log-path", logPath);
}

main().catch(reportFailure);
