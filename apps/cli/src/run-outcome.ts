import type { ExecutionRenderer, OutputCapabilities } from "@seqlane/tui";
import type { RunnerSupervisionResult } from "./runner-client.js";
import type { RunCommandResult, RunWorkflowIdentity } from "./cli-contracts.js";
import { writeDiagnostic } from "./command.js";
import {
  createRunSuccessResult,
  createRunCancellationResult,
  createRunFailureResult,
  remoteError,
  type RunIdentity,
} from "./run-result.js";

export interface RunnerResultContext {
  readonly jsonMode: boolean;
  readonly renderer: ExecutionRenderer | undefined;
  readonly capabilities: OutputCapabilities;
  readonly workflow: RunWorkflowIdentity;
  readonly identity: RunIdentity | undefined;
}

/** Maps authoritative worker outcomes to the existing final-result contract. */
export function mapRunnerCommandResult(
  result: RunnerSupervisionResult,
  { jsonMode, renderer, capabilities, workflow, identity }: RunnerResultContext,
): RunCommandResult | void {
  if ("failure" in result) {
    return reportRunnerFailure(result.failure, {
      jsonMode,
      renderer,
      capabilities,
      workflow,
      identity,
    });
  }
  if (!jsonMode || identity === undefined) return;
  if (result.terminalEvent.type === "run.succeeded") {
    return createRunSuccessResult(
      workflow,
      identity,
      result.terminalEvent.output,
    );
  }
  if (result.terminalEvent.type === "run.cancelled") {
    const signal =
      "cancellationSignal" in result ? result.cancellationSignal : undefined;
    return createRunCancellationResult(
      workflow,
      identity,
      signal === undefined ? "runtime_cancelled" : "signal",
      signal === undefined
        ? "Run cancelled by the runtime"
        : `Run cancelled after ${signal}`,
    );
  }
  return createRunFailureResult(
    remoteError(result.terminalEvent.error),
    result.terminalEvent.phase ?? "execution",
    workflow,
    identity,
  );
}

function reportRunnerFailure(
  failure: import("./runner-client.js").RunnerFailure,
  { jsonMode, renderer, capabilities, workflow }: RunnerResultContext,
): RunCommandResult | void {
  if (renderer?.handleRunnerFailure !== undefined)
    renderer.handleRunnerFailure(failure);
  else if (!jsonMode)
    writeDiagnostic(
      capabilities.stderr,
      "seqlane runner error: " + failure.message,
    );
  return jsonMode
    ? createRunFailureResult(failure, "execution", workflow)
    : undefined;
}
