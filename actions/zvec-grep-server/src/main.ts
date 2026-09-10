import { resolve } from "node:path";

import * as core from "@actions/core";
import { buildZvecEnvironment } from "./commands.js";
import { parseListenAddress } from "./readiness.js";
import { runZvecGrepLifecycle } from "./lifecycle.js";

export { packageExecutionDirectory, processAnchorPath } from "./lifecycle.js";

function runnerTempPath(fileName: string): string {
  return resolve(process.env.RUNNER_TEMP ?? "/tmp", fileName);
}

export async function run(): Promise<void> {
  const parsedListen = parseListenAddress(
    core.getInput("listen") || "127.0.0.1:7999",
  );
  const workingDirectory = core.getInput("working-directory", {
    required: true,
  });
  const version = core.getInput("version") || "0.2.1";
  const packageManager = core.getInput("package-manager") || "pnpm";
  const home = core.getInput("home") || runnerTempPath("zvec-grep");
  const embedding = core.getInput("embedding") || "local/potion-code-16m-v2";
  const maxFilesize = core.getInput("max-filesize") || "1M";
  const additionalGlobs = core.getMultilineInput("glob");
  const modelCache = core.getBooleanInput("model-cache")
    ? runnerTempPath("zvec-grep-model-cache")
    : undefined;
  const timeoutSeconds = Number(
    core.getInput("startup-timeout-seconds") || "30",
  );
  if (!version) throw new Error("version is required");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("startup-timeout-seconds must be a positive integer");
  }

  const env = buildZvecEnvironment(process.env, home, modelCache);
  const packageSpec = `@zvec/zvec-grep@${version}`;
  const logPath = runnerTempPath("zvec-grep.log");

  await runZvecGrepLifecycle(
    {
      packageManager,
      packageSpec,
      projectDirectory: workingDirectory,
      listen: parsedListen.listen,
      home,
      embedding,
      maxFilesize,
      additionalGlobs,
      environment: env,
      logPath,
      timeoutMilliseconds: timeoutSeconds * 1_000,
    },
    {
      saveState: core.saveState,
      warning: core.warning,
    },
  );

  core.setOutput("mcp-url", parsedListen.mcpUrl);
  core.setOutput("log-path", logPath);
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
