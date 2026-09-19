import {
  startRunnerProcess,
  type RunnerProcessOptions,
} from "@seqlane/runtime/runner";
import { fileURLToPath } from "node:url";
import {
  agentRuntimeConfigurationEnvironment,
  directRunAdapterConfigurationEnvironment,
  loadDirectRunAgentRuntimeFactory,
  loadAgentRuntimeFactory,
} from "./agent-runtime.js";

/**
 * Selects a concrete agent runtime in the CLI-owned child-process entrypoint.
 * The runner IPC payload remains executor-neutral.
 */
export function createRunnerProcessOptions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RunnerProcessOptions {
  if (environment[directRunAdapterConfigurationEnvironment] !== undefined) {
    return {
      createAgentRuntimeFactory: () =>
        loadDirectRunAgentRuntimeFactory(environment),
    };
  }
  if (environment[agentRuntimeConfigurationEnvironment] === undefined) {
    return {};
  }
  return {
    createAgentRuntimeFactory: () => loadAgentRuntimeFactory(environment),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRunnerProcess({
    workerEntrypoint: true,
    ...createRunnerProcessOptions(),
  });
}
