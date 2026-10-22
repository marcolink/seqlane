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
import {
  captureTelemetryConfigurationEnvironment,
  encodeTelemetryConfiguration,
  exportTelemetry,
  runCliWithTelemetry,
  telemetryConfigurationEnvironment,
  type InProcessTelemetry,
} from "@seqlane/runtime/private/telemetry";
import { encodeTraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import { traceCarrierEnvironment } from "./trace-carrier-environment.js";

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
export async function executeRunnerCommand(
  options: RunnerCommandOptions,
): Promise<{
  readonly exitStatus: 0 | 1 | 130;
  readonly commandResult: RunCommandResult | void;
}> {
  const telemetryConfiguration = captureTelemetryConfigurationEnvironment(
    process.env,
  );
  if (telemetryConfiguration === undefined) {
    return executeRunnerCommandWithTelemetry(
      options,
      undefined,
      undefined,
      undefined,
    );
  }
  const { value, telemetry, spans } = await runCliWithTelemetry(
    (carrier, collector) =>
      executeRunnerCommandWithTelemetry(
        options,
        carrier,
        collector,
        telemetryConfiguration,
      ),
  );
  if (telemetryConfiguration !== undefined) {
    const snapshot = telemetry;
    const cliSpans = spans.map((span) => ({
      name: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId === undefined
        ? {}
        : { parentSpanId: span.parentSpanId }),
      startTime: Number(span.startTime / 1_000_000n),
      ...(span.endTime === undefined
        ? {}
        : { endTime: Number(span.endTime / 1_000_000n) }),
      startTimeUnixNano: String(span.startTime),
      ...(span.endTime === undefined
        ? {}
        : { endTimeUnixNano: String(span.endTime) }),
      kind: span.kind,
      links: span.links.map((link) => ({
        traceId: link.traceId,
        spanId: link.spanId,
        attributes: { ...link.attributes },
      })),
      status:
        span.status === "ended" ? ("ended" as const) : ("started" as const),
      attributes: { "seqlane.service.role": "cli" },
    }));
    try {
      const result = await exportTelemetry(telemetryConfiguration, {
        spans: [...snapshot.spans, ...cliSpans],
        logs: snapshot.logs,
        metrics: snapshot.metrics,
      });
      if (
        result.failed ||
        result.droppedRecords > 0 ||
        snapshot.droppedRecords > 0
      ) {
        writeDiagnostic(
          options.capabilities.stderr,
          "seqlane telemetry export incomplete",
        );
      }
    } catch {
      // Telemetry failures never change the task result.
      writeDiagnostic(
        options.capabilities.stderr,
        "seqlane telemetry export failed",
      );
    }
  }
  return value;
}

async function executeRunnerCommandWithTelemetry(
  {
    request,
    sourceReference,
    classifierOptions,
    adapterConfiguration,
    jsonMode,
    dry,
    terminalMode,
    capabilities,
  }: RunnerCommandOptions,
  carrier: TraceCarrier | undefined,
  telemetry: InProcessTelemetry | undefined,
  telemetryConfiguration: ReturnType<
    typeof captureTelemetryConfigurationEnvironment
  >,
): Promise<{
  readonly exitStatus: 0 | 1 | 130;
  readonly commandResult: RunCommandResult | void;
}> {
  let renderer: ReturnType<typeof createCliRenderer>["renderer"] | undefined;
  let dispatcher: ReturnType<typeof createEventDispatcher> | undefined;
  let runnerClient: import("./runner-client.js").RunnerClient | undefined;
  let receivedWorkerTelemetry = false;
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
        ...(carrier === undefined
          ? {}
          : { [traceCarrierEnvironment]: encodeTraceCarrier(carrier) }),
        ...(telemetryConfiguration === undefined
          ? {}
          : {
              [telemetryConfigurationEnvironment]: encodeTelemetryConfiguration(
                telemetryConfiguration,
              ),
            }),
        ...(adapterConfiguration === undefined
          ? {}
          : {
              [directRunAdapterConfigurationEnvironment]: adapterConfiguration,
            }),
      },
      onExecutionEvent: (event) => {
        telemetry?.record(event);
        dispatcher?.consume(event);
        if (event.type === "run.started" && identity === undefined) {
          identity = {
            workId: event.workId,
            runId: event.runId,
            startedAt: event.metadata.occurredAt,
          };
        }
      },
      onTelemetrySpans: (frame) => {
        receivedWorkerTelemetry = true;
        telemetry?.recordDropped(frame.droppedRecords);
        if (frame.queuePressure !== undefined)
          telemetry?.recordQueuePressure(frame.queuePressure);
        for (const span of frame.spans) telemetry?.recordSpan(span);
      },
      onTelemetryDiagnostic: () =>
        writeDiagnostic(
          capabilities.stderr,
          "seqlane telemetry worker snapshot unavailable",
        ),
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
    if (telemetryConfiguration !== undefined && !receivedWorkerTelemetry) {
      writeDiagnostic(
        capabilities.stderr,
        "seqlane telemetry worker snapshot unavailable",
      );
    }
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
