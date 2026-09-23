import {
  startRunnerProcess,
  type RunnerProcessOptions,
} from "@seqlane/runtime/runner";
import { fileURLToPath } from "node:url";
import { captureClassifierConnectionEnvironment } from "./classifier-environment.js";
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
  environment: NodeJS.ProcessEnv = process.env,
): RunnerProcessOptions {
  const classifierConnection =
    captureClassifierConnectionEnvironment(environment);
  const classifierOptions =
    classifierConnection === undefined ? {} : { classifierConnection };
  if (environment[directRunAdapterConfigurationEnvironment] !== undefined) {
    return {
      ...classifierOptions,
      createAgentRuntimeFactory: () =>
        loadDirectRunAgentRuntimeFactory(environment),
    };
  }
  if (environment[agentRuntimeConfigurationEnvironment] === undefined) {
    return classifierOptions;
  }
  return {
    ...classifierOptions,
    createAgentRuntimeFactory: () => loadAgentRuntimeFactory(environment),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRunnerProcess({
    workerEntrypoint: true,
    ...createRunnerProcessOptions(),
  });
}
