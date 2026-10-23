import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "@actions/core";
import { Effect } from "effect";
import { startOpenCodeEffect } from "./lifecycle.js";

function runnerTempPath(fileName: string): string {
  return resolve(process.env.RUNNER_TEMP ?? "/tmp", fileName);
}

export function processAnchorPath(): string {
  return fileURLToPath(new URL("../dist/process-anchor.js", import.meta.url));
}

async function runWithActionSignals<A>(
  effect: Effect.Effect<A, Error>,
): Promise<A> {
  const controller = new AbortController();
  const onInterrupt = (signal: NodeJS.Signals) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error(`OpenCode startup interrupted by ${signal}`));
  };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await Effect.runPromise(effect, { signal: controller.signal });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export async function run(): Promise<void> {
  const workingDirectory = core.getInput("working-directory", {
    required: true,
  });
  const hostname = core.getInput("hostname") || "127.0.0.1";
  const port = core.getInput("port") || "4096";
  const executable = core.getInput("executable", { required: true });
  const timeoutSeconds = Number(
    core.getInput("startup-timeout-seconds") || "30",
  );
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("startup-timeout-seconds must be a positive integer");
  }

  const logPath = runnerTempPath("opencode.log");
  await runWithActionSignals(
    startOpenCodeEffect(
      {
        workingDirectory,
        executable,
        hostname,
        port,
        logPath,
        startupTimeoutMilliseconds: timeoutSeconds * 1_000,
        environment: process.env,
        anchorPath: processAnchorPath(),
      },
      { saveState: core.saveState },
    ),
  );

  core.setOutput("url", `http://${hostname}:${port}`);
  core.setOutput("log-path", logPath);
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
