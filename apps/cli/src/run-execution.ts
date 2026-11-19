import { Effect } from "effect";
import type { RunRequest, SeqlaneExecutionEvent } from "@seqlane/protocol";
import type { RunCommandResult } from "./cli-contracts.js";
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
import { errorMessage, writeDiagnostic } from "./command.js";
import { closeRunResources } from "./run-lifecycle.js";
import type { RunIdentity } from "./run-result.js";
import { mapRunnerCommandResult } from "./run-outcome.js";
import { writeSessionUiDiagnostic } from "./session-ui-diagnostic.js";
import {
  captureTelemetryConfigurationEnvironment,
  encodeTelemetryConfiguration,
  exportTelemetryEffect,
  telemetryConfigurationEnvironment,
  withCliTelemetryEffect,
  type InProcessTelemetry,
} from "@seqlane/runtime/private/telemetry";
import { encodeTraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import { traceCarrierEnvironment } from "./trace-carrier-environment.js";
import {
  spawnRunnerProcess,
  superviseRunnerEffect,
  type RunnerChild,
} from "./runner-client.js";
import { createTerminalUserInputConsumer } from "./terminal-user-input.js";

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

type RunnerCommandResult = {
  readonly exitStatus: 0 | 1 | 130;
  readonly commandResult: RunCommandResult | void;
};

/** Evaluates the CLI run application after Oclif has parsed and validated flags. */
export async function executeRunnerCommand(
  options: RunnerCommandOptions,
): Promise<RunnerCommandResult> {
  const telemetryConfiguration = captureTelemetryConfigurationEnvironment(
    process.env,
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      if (telemetryConfiguration === undefined) {
        return yield* executeRunnerCommandEffect(
          options,
          undefined,
          undefined,
          undefined,
        );
      }

      const captured = yield* withCliTelemetryEffect(({ carrier, collector }) =>
        executeRunnerCommandEffect(
          options,
          carrier,
          collector,
          telemetryConfiguration,
        ),
      );
      const snapshot = captured.snapshot();
      const cliSpans = snapshot.spans.map((span) => ({
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
      yield* exportTelemetryEffect(telemetryConfiguration, {
        spans: [...snapshot.telemetry.spans, ...cliSpans],
        logs: snapshot.telemetry.logs,
        metrics: snapshot.telemetry.metrics,
      }).pipe(
        Effect.map((result) => {
          if (
            result.failed ||
            result.droppedRecords > 0 ||
            snapshot.telemetry.droppedRecords > 0
          ) {
            writeDiagnostic(
              options.capabilities.stderr,
              "seqlane telemetry export incomplete",
            );
          }
        }),
        Effect.catch(() =>
          Effect.sync(() =>
            writeDiagnostic(
              options.capabilities.stderr,
              "seqlane telemetry export failed",
            ),
          ),
        ),
      );
      return captured.value;
    }),
  );
}

function executeRunnerCommandEffect(
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
): Effect.Effect<RunnerCommandResult, unknown> {
  let renderer: ReturnType<typeof createCliRenderer>["renderer"] | undefined;
  let runnerChild: RunnerChild | undefined;
  let interactionConsumer:
    ReturnType<typeof createTerminalUserInputConsumer> | undefined;
  let receivedWorkerTelemetry = false;
  let identity: RunIdentity | undefined;

  const application = Effect.gen(function* () {
    renderer =
      terminalMode === undefined
        ? undefined
        : createCliRenderer(terminalMode, capabilities).renderer;
    if (request.interactionPolicy?.mode === "user-input" && !dry) {
      if (renderer?.handleUserInput === undefined) {
        throw new Error("Interactive input requires the human renderer");
      }
      interactionConsumer = createTerminalUserInputConsumer(
        capabilities,
        (input) => renderer?.handleUserInput?.(input),
      );
    }

    const consumeExecutionEvent = (event: SeqlaneExecutionEvent): void => {
      if (dry) {
        if (event.type === "run.plan") {
          capabilities.stdout.write(JSON.stringify(event.plan, null, 2) + "\n");
        }
        return;
      }
      renderer?.handle(event);
      interactionConsumer?.handle(event);
    };

    const baseEnvironment = { ...process.env };
    delete baseEnvironment[agentRuntimeConfigurationEnvironment];
    delete baseEnvironment[directRunAdapterConfigurationEnvironment];
    const environment = createClassifierStartupEnvironment(
      baseEnvironment,
      classifierOptions.url,
      classifierOptions.model,
    );
    const child = yield* Effect.tryPromise({
      try: async () =>
        spawnRunnerProcess({
          environment: {
            ...environment,
            ...(carrier === undefined
              ? {}
              : { [traceCarrierEnvironment]: encodeTraceCarrier(carrier) }),
            ...(telemetryConfiguration === undefined
              ? {}
              : {
                  [telemetryConfigurationEnvironment]:
                    encodeTelemetryConfiguration(telemetryConfiguration),
                }),
            ...(adapterConfiguration === undefined
              ? {}
              : {
                  [directRunAdapterConfigurationEnvironment]:
                    adapterConfiguration,
                }),
          },
        }),
      catch: (cause) => cause,
    });
    runnerChild = child;
    const result = yield* superviseRunnerEffect(child, request, {
      onExecutionEvent: (event) => {
        telemetry?.record(event);
        consumeExecutionEvent(event);
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
      ...(interactionConsumer === undefined
        ? {}
        : {
            onReady: interactionConsumer.bindCancellation,
            onInteractionRequested: interactionConsumer.onRequested,
          }),
    });
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
    } satisfies RunnerCommandResult;
  });

  const cleanup = Effect.tryPromise({
    try: () =>
      closeRunResources({
        closeClient: () => {
          interactionConsumer?.close();
          if (
            runnerChild !== undefined &&
            runnerChild.exitCode === null &&
            runnerChild.signalCode === null
          ) {
            runnerChild.kill?.("SIGTERM");
          }
        },
        finishRenderer: () => renderer?.finish(),
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((cleanupErrors) => {
      for (const error of cleanupErrors) {
        writeDiagnostic(
          capabilities.stderr,
          "seqlane cleanup error: " + errorMessage(error),
        );
      }
    }),
    Effect.catch((error) =>
      Effect.sync(() =>
        writeDiagnostic(
          capabilities.stderr,
          "seqlane cleanup error: " + errorMessage(error),
        ),
      ),
    ),
  );
  return application.pipe(Effect.ensuring(cleanup));
}
