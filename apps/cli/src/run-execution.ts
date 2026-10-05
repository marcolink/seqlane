import type { RunRequest, SeqlaneExecutionEvent } from "@seqlane/protocol";
import type { RunCommandResult } from "./cli-contracts.js";
import { createEventDispatcher } from "./event-dispatcher.js";
import {
  createClassifierStartupEnvironment,
  type ClassifierCliOptions,
} from "./classifier-environment.js";
import { createCliRenderer } from "./output.js";
import type { OutputCapabilities, RendererMode } from "@seqlane/tui";
import {
  agentRuntimeConfigurationEnvironment,
  directRunAdapterConfigurationEnvironment,
} from "./agent-runtime.js";
import {
  contextualizeCommandError,
  errorMessage,
  writeDiagnostic,
} from "./command.js";
import { closeRunResources } from "./run-lifecycle.js";
import type { RunIdentity } from "./run-result.js";
import { mapRunnerCommandResult } from "./run-outcome.js";
import { writeSessionUiDiagnostic } from "./session-ui-diagnostic.js";

export interface RunnerCommandOptions {
  readonly request: RunRequest;
  readonly sourceReference: string;
  readonly classifierOptions: ClassifierCliOptions;
  readonly adapterConfiguration?: string;
  readonly jsonMode: boolean;
  readonly dry: boolean;
  readonly terminalMode: RendererMode | undefined;
  readonly capabilities: OutputCapabilities;
}

/** Coordinates the supervised worker, output consumers, and bounded cleanup. */
export async function executeRunnerCommand({
  request,
  sourceReference,
  classifierOptions,
  adapterConfiguration,
  jsonMode,
  dry,
  terminalMode,
  capabilities,
}: RunnerCommandOptions): Promise<{
  readonly exitStatus: 0 | 1 | 130;
  readonly commandResult: RunCommandResult | void;
}> {
  let renderer: ReturnType<typeof createCliRenderer>["renderer"] | undefined;
  let dispatcher: ReturnType<typeof createEventDispatcher> | undefined;
  let runnerClient: import("./runner-client.js").RunnerClient | undefined;
  let identity: RunIdentity | undefined;

  try {
    try {
      renderer =
        terminalMode === undefined
          ? undefined
          : createCliRenderer(terminalMode, capabilities).renderer;
    } catch (error) {
      throw contextualizeCommandError(errorMessage(error), error);
    }

    const outputConsumer = {
      consume: (event: SeqlaneExecutionEvent) => {
        try {
          if (dry) {
            if (event.type === "run.plan") {
              capabilities.stdout.write(
                JSON.stringify(event.plan, null, 2) + "\n",
              );
            }
            return;
          }
          renderer?.handle(event);
        } catch (error) {
          writeDiagnostic(
            capabilities.stderr,
            "seqlane output error: " + errorMessage(error),
          );
        }
      },
      flush: async () => undefined,
      close: async () => undefined,
    };
    dispatcher = createEventDispatcher(
      [{ name: "output", consumer: outputConsumer }],
      {
        onDiagnostic: (message) =>
          writeDiagnostic(capabilities.stderr, message),
      },
    );

    const { launchRunner } = await import("./runner-client.js");
    const baseEnvironment = { ...process.env };
    delete baseEnvironment[agentRuntimeConfigurationEnvironment];
    delete baseEnvironment[directRunAdapterConfigurationEnvironment];
    const environment = createClassifierStartupEnvironment(
      baseEnvironment,
      classifierOptions.url,
      classifierOptions.model,
    );
    runnerClient = launchRunner(request, {
      environment: {
        ...environment,
        ...(adapterConfiguration === undefined
          ? {}
          : {
              [directRunAdapterConfigurationEnvironment]: adapterConfiguration,
            }),
      },
      onExecutionEvent: (event) => {
        dispatcher?.consume(event);
        if (event.type === "run.started" && identity === undefined) {
          identity = {
            workId: event.workId,
            runId: event.runId,
            startedAt: event.metadata.occurredAt,
          };
        }
      },
      onRuntimeSessionUiAvailable: (notification) => {
        if (renderer?.mode === "human") return;
        if (renderer?.handleRuntimeSessionUi !== undefined) {
          renderer.handleRuntimeSessionUi(notification);
          return;
        }
        if (!jsonMode) {
          writeSessionUiDiagnostic(capabilities, notification.browserUrl);
        }
      },
    });
    const result = await runnerClient.result;
    return {
      exitStatus: result.status,
      commandResult: mapRunnerCommandResult(result, {
        jsonMode,
        renderer,
        capabilities,
        workflow: { id: request.workflow.id, reference: sourceReference },
        identity,
      }),
    };
  } finally {
    const cleanupErrors = await closeRunResources({
      dispatcher,
      closeClient: () => runnerClient?.close(),
      finishRenderer: () => renderer?.finish(),
    });
    for (const error of cleanupErrors) {
      writeDiagnostic(
        capabilities.stderr,
        "seqlane cleanup error: " + errorMessage(error),
      );
    }
  }
}
