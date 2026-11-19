import {
  startRunnerProcess,
  type RunnerProcessOptions,
} from "@seqlane/runtime/runner";
import { fileURLToPath } from "node:url";
import { captureTraceCarrierEnvironment } from "./trace-carrier-environment.js";
import { captureClassifierConnectionEnvironment } from "./classifier-environment.js";
import {
  agentRuntimeConfigurationEnvironment,
  directRunAdapterConfigurationEnvironment,
  loadDirectRunAgentRuntimeFactory,
  loadAgentRuntimeFactory,
} from "./agent-runtime.js";
import { captureTelemetryConfigurationEnvironment } from "@seqlane/runtime/private/telemetry";

/**
 * Selects a concrete agent runtime in the CLI-owned child-process entrypoint.
 * The runner IPC payload remains executor-neutral.
 */
export function createRunnerProcessOptions(
  environment: NodeJS.ProcessEnv = process.env,
): RunnerProcessOptions {
  const traceCarrier = captureTraceCarrierEnvironment(environment);
  const telemetryConfiguration =
    captureTelemetryConfigurationEnvironment(environment);
  const telemetryOptions =
    telemetryConfiguration === undefined ? {} : { telemetryConfiguration };
  const traceCarrierOptions =
    traceCarrier === undefined ? {} : { traceCarrier };
  const classifierConnection =
    captureClassifierConnectionEnvironment(environment);
  const classifierOptions =
    classifierConnection === undefined ? {} : { classifierConnection };
  if (environment[directRunAdapterConfigurationEnvironment] !== undefined) {
    return {
      ...traceCarrierOptions,
      ...telemetryOptions,
      ...classifierOptions,
      createAgentRuntimeFactory: () =>
        loadDirectRunAgentRuntimeFactory(environment),
    };
  }
  if (environment[agentRuntimeConfigurationEnvironment] === undefined) {
    return {
      ...traceCarrierOptions,
      ...classifierOptions,
      ...telemetryOptions,
    };
  }
  return {
    ...traceCarrierOptions,
    ...classifierOptions,
    ...telemetryOptions,
    createAgentRuntimeFactory: () => loadAgentRuntimeFactory(environment),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRunnerProcess({
    workerEntrypoint: true,
    ...createRunnerProcessOptions(),
  });
}
