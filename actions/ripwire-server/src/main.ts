import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "@actions/core";
import { Effect } from "effect";
import { assertDirectory } from "./filesystem.js";
import { parseRipwireInputs } from "./config.js";
import {
  installRipwire,
  removeInstallDirectory,
  RipwireInstallError,
} from "./release.js";
import { RipwireStartupError, runRipwireLifecycle } from "./lifecycle.js";
import { createSessionToken } from "./token.js";
import { CLEANUP_ONLY_STATE_KEY, serializeCleanupOnlyState } from "./state.js";

function runnerTempPath(fileName: string): string {
  return resolve(process.env.RUNNER_TEMP ?? "/tmp", fileName);
}

export { packageExecutionDirectory } from "./lifecycle.js";
export { processAnchorPath } from "./lifecycle.js";

export interface InstallFailureHooks {
  readonly saveState: (name: string, value: string) => void;
  readonly warning: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function recordInstallFailure(
  error: unknown,
  hooks: InstallFailureHooks,
): void {
  if (!(error instanceof RipwireInstallError)) return;
  hooks.warning(
    `Ripwire partial install cleanup failed: ${describeError(error.cleanupError)}`,
  );
  hooks.saveState("install-directory", error.installDirectory);
  hooks.saveState(CLEANUP_ONLY_STATE_KEY, serializeCleanupOnlyState());
}

async function runWithActionSignals<A>(
  effect: Effect.Effect<A, Error>,
): Promise<A> {
  const controller = new AbortController();
  const onInterrupt = (signal: NodeJS.Signals) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error(`Ripwire startup interrupted by ${signal}`));
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

  const runnerTemp = process.env.RUNNER_TEMP ?? "/tmp";
  const logPath = runnerTempPath("ripwire.log");
  let install: Awaited<ReturnType<typeof installRipwire>> | undefined;
  const program = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => assertDirectory(config.workingDirectory),
      catch: (cause) =>
        new Error("Ripwire working directory is invalid", { cause }),
    });
    install = yield* Effect.tryPromise({
      try: (signal) =>
        installRipwire({ version: config.version, runnerTemp, signal }),
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Ripwire installation failed", { cause }),
    });
    yield* Effect.sync(() => {
      core.saveState("install-directory", install!.binaryDirectory);
      core.addPath(install!.binaryDirectory);
    });
    yield* runRipwireLifecycle(
      {
        config,
        binaryDirectory: install.binaryDirectory,
        logPath,
        environment: process.env,
        sessionToken,
      },
      { saveState: core.saveState, warning: core.warning },
    );
    yield* Effect.sync(() => {
      core.setOutput("mcp-url", config.mcpUrl);
      core.setOutput("log-path", logPath);
      core.setOutput("binary-path", install!.binaryPath);
      core.setOutput("version", install!.version);
      core.setOutput("mcp-token", sessionToken);
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const error =
          cause instanceof Error
            ? cause
            : new Error("Ripwire startup failed", { cause });
        yield* Effect.sync(() => {
          try {
            recordInstallFailure(error, {
              saveState: core.saveState,
              warning: core.warning,
            });
          } catch (stateError) {
            core.warning(
              `Ripwire cleanup state persistence failed: ${describeError(stateError)}`,
            );
          }
        });
        const cleanupSucceeded =
          !(error instanceof RipwireStartupError) || error.cleanupSucceeded;
        if (install && cleanupSucceeded) {
          yield* Effect.tryPromise({
            try: () =>
              removeInstallDirectory(install!.binaryDirectory, runnerTemp),
            catch: (cleanupError) => cleanupError,
          }).pipe(
            Effect.catch((cleanupError) =>
              Effect.sync(() =>
                core.warning(
                  `Ripwire install cleanup failed: ${describeError(cleanupError)}`,
                ),
              ),
            ),
          );
        }
        return yield* Effect.fail(error);
      }),
    ),
  );
  await runWithActionSignals(program);
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
