import { randomUUID } from "node:crypto";
import { Effect, Exit, Metric, Tracer } from "effect";
import {
  encodeSeqlaneExecutionEvent,
  safeErrorMessage,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { RuntimeError } from "@seqlane/core";
import {
  publishRunOutcome,
  settleRunProgram,
} from "../runtime/execution/settle-run-program.js";
import {
  createEffectPlanProgram,
  type EffectPlanRunResult,
} from "../runtime/execution/effect-plan.js";
import type { RunRequest } from "@seqlane/protocol";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import type { TelemetrySpanSnapshot } from "@seqlane/protocol/private/telemetry-span-snapshot";
import type { TelemetryConfiguration } from "../private/telemetry/configuration.js";
import { encodeTelemetrySpanSnapshotFrame } from "@seqlane/protocol/private/telemetry-span-snapshot";
import { createExecutionEventBridge } from "./event-bridge.js";
import {
  createByteBoundedEventQueue,
  EventQueueDeliveryError,
  type EventQueuePressure,
} from "./byte-bounded-event-queue.js";
import type { ByteBoundedEventQueue } from "./byte-bounded-event-queue.js";
import {
  createNativeSpanCollector,
  currentTraceCarrier,
  withWorkerRunSpan,
} from "../private/telemetry/run-scope.js";
import {
  DEFAULT_IPC_ACK_TIMEOUT_MS,
  sendWithAcknowledgement,
} from "./ipc-ack.js";
import { loadWorkflow, type LoadedWorkflow } from "./workflow/load-workflow.js";
import { createSeqlanePlanSnapshot } from "./workflow/plan-snapshot.js";
import { OwnedProcessRegistry } from "./owned-process-registry.js";
import {
  resolveRuntimeProfile,
  type RuntimeExecution,
  type RuntimeProfileResolutionOptions,
  type RuntimeSessionUiNotifier,
} from "./profile/runtime-profile.js";
import {
  encodeRuntimeSessionUiAvailable,
  type RuntimeSessionUiAvailable,
} from "./runtime-session-ui.js";

export interface RunnerHost {
  on(event: "message", listener: (message: unknown) => void): this;
  send(message: string, callback?: (error?: Error) => void): boolean;
  exit(code?: number): never;
}

export interface RunnerRunControl {
  cancellationRequested: boolean;
  supervisorDisconnected?: boolean;
  supervisorDisconnectController?: AbortController;
  readonly ipcAckTimeoutMs?: number;
  readonly traceCarrier?: TraceCarrier;
  tracer?: Tracer.Tracer;
  metricRegistry?: Map<string, unknown>;
  readonly telemetryConfiguration?: TelemetryConfiguration;
  abortController?: AbortController;
  ownedProcessRegistry?: OwnedProcessRegistry;
}

export type RuntimeExecutionResolver = (
  profile: RunRequest["runtime"],
  taskDefinitions: LoadedWorkflow["taskDefinitions"],
  signal: AbortSignal,
  input: RunRequest["input"],
  onSessionUiAvailable?: RuntimeSessionUiNotifier,
  options?: RuntimeProfileResolutionOptions,
) => RuntimeExecution | Promise<RuntimeExecution>;

function boundedSnapshotFrame(
  snapshot: ReturnType<
    ReturnType<typeof createNativeSpanCollector>["snapshot"]
  >,
  queuePressure: EventQueuePressure,
) {
  const spans: TelemetrySpanSnapshot[] = [];
  let droppedRecords = snapshot.droppedRecords;
  let retainedBytes = 0;
  for (const span of snapshot.spans) {
    const bytes = Buffer.byteLength(JSON.stringify(span), "utf8");
    if (bytes > 3 * 1024 * 1024 || retainedBytes + bytes > 3 * 1024 * 1024) {
      droppedRecords += 1;
      continue;
    }
    spans.push(span);
    retainedBytes += bytes;
  }
  return {
    type: "runner.telemetry.spans" as const,
    spans,
    droppedRecords,
    queuePressure,
  };
}

function reportWorkerTelemetryDiagnostic(): void {
  try {
    process.stderr.write("seqlane telemetry worker snapshot incomplete\n");
  } catch {
    // A telemetry diagnostic cannot change the canonical run result.
  }
}

export function requestRunnerCancellation(control: RunnerRunControl): void {
  if (control.cancellationRequested) return;
  control.cancellationRequested = true;
  control.abortController?.abort();
}

function hasCause(error: unknown, cause: unknown): boolean {
  return (
    error === cause ||
    (error instanceof EventQueueDeliveryError && error.cause === cause)
  );
}

function withSecondaryRunCauses(
  primary: unknown,
  secondary: readonly unknown[],
): unknown {
  const distinctSecondary = secondary.filter(
    (cause, index) =>
      !hasCause(cause, primary) &&
      secondary.findIndex((candidate) => candidate === cause) === index,
  );
  if (distinctSecondary.length === 0) return primary;
  const message = [
    `Required event delivery failed: ${safeErrorMessage(primary)}`,
    ...distinctSecondary.map(
      (cause) => `Run cleanup also failed: ${safeErrorMessage(cause)}`,
    ),
  ].join("; ");
  return new Error(message, {
    cause: new AggregateError([primary, ...distinctSecondary]),
  });
}

function sendEvent(
  host: RunnerHost,
  control: RunnerRunControl,
  event: SeqlaneExecutionEvent,
  timeoutMs = DEFAULT_IPC_ACK_TIMEOUT_MS,
  acceptedEncoding?: string,
): Promise<void> {
  if (control.supervisorDisconnected) {
    return Promise.reject(new Error("Runner supervisor disconnected"));
  }
  const encoded = acceptedEncoding ?? encodeSeqlaneExecutionEvent(event);
  return sendWithAcknowledgement(
    (callback) => host.send(encoded, callback),
    timeoutMs,
    control.supervisorDisconnectController?.signal,
  );
}

function sendRuntimeSessionUi(
  host: RunnerHost,
  control: RunnerRunControl,
  notification: RuntimeSessionUiAvailable,
  timeoutMs = DEFAULT_IPC_ACK_TIMEOUT_MS,
): Promise<void> {
  if (control.supervisorDisconnected) {
    return Promise.reject(new Error("Runner supervisor disconnected"));
  }
  const encoded = encodeRuntimeSessionUiAvailable(notification);
  return sendWithAcknowledgement(
    (callback) => host.send(encoded, callback),
    timeoutMs,
    control.supervisorDisconnectController?.signal,
  );
}

export async function startRun(
  host: RunnerHost,
  request: RunRequest,
  createWorkId: () => string,
  createRunId: () => string,
  retainWorkflow: (workflow: LoadedWorkflow) => void,
  control: RunnerRunControl,
  resolveExecution: RuntimeExecutionResolver = resolveRuntimeProfile,
  createInvocationId: (_nodeId?: string) => string = () => randomUUID(),
): Promise<void> {
  const ownedProcessRegistry = new OwnedProcessRegistry(
    host,
    control.ipcAckTimeoutMs ?? DEFAULT_IPC_ACK_TIMEOUT_MS,
  );
  control.ownedProcessRegistry = ownedProcessRegistry;
  let lastAcknowledgedSequence = 0;
  const spanCollector =
    control.telemetryConfiguration === undefined
      ? undefined
      : createNativeSpanCollector();
  const metricRegistry = new Map();
  control.tracer = spanCollector?.tracer;
  control.metricRegistry = metricRegistry;
  const encodedEvents = new WeakMap<SeqlaneExecutionEvent, string>();
  let workerProgram = Effect.scoped(
    Effect.gen(function* () {
      const ackTimeoutMs =
        control.ipcAckTimeoutMs ?? DEFAULT_IPC_ACK_TIMEOUT_MS;
      const queue = yield* createByteBoundedEventQueue({
        maxPendingBytes: 16 * 1024 * 1024,
        sendTimeoutMs: ackTimeoutMs,
        send: (event) =>
          Effect.tryPromise({
            try: async () => {
              await sendEvent(
                host,
                control,
                event,
                ackTimeoutMs,
                encodedEvents.get(event),
              );
              lastAcknowledgedSequence = event.metadata.sequence;
            },
            catch: (cause) => cause,
          }),
        onDeliveryFailure: () => requestRunnerCancellation(control),
      });
      const result = yield* withWorkerRunSpan(
        Effect.gen(function* () {
          const activeCarrier = yield* currentTraceCarrier;
          const result = yield* Effect.tryPromise({
            try: () =>
              startRunScoped(
                host,
                request,
                createWorkId,
                createRunId,
                retainWorkflow,
                control,
                resolveExecution,
                createInvocationId,
                queue,
                () => lastAcknowledgedSequence,
                activeCarrier,
                encodedEvents,
                ownedProcessRegistry,
              ),
            catch: (cause) => cause,
          });
          const outcome =
            result.exitCode === 1
              ? "failed"
              : control.cancellationRequested
                ? "cancelled"
                : "succeeded";
          yield* Effect.annotateCurrentSpan("seqlane.outcome", outcome);
          return result;
        }),
        control.traceCarrier,
      );
      if (spanCollector !== undefined) {
        const snapshot = spanCollector.snapshot();
        try {
          const frame = boundedSnapshotFrame(
            snapshot,
            queue.snapshotPressure(),
          );
          const encoded = encodeTelemetrySpanSnapshotFrame(frame);
          if (frame.droppedRecords > 0) reportWorkerTelemetryDiagnostic();
          yield* Effect.tryPromise({
            try: () =>
              control.supervisorDisconnected
                ? Promise.reject(new Error("Runner supervisor disconnected"))
                : sendWithAcknowledgement(
                    (callback) => host.send(encoded, callback),
                    control.ipcAckTimeoutMs ?? DEFAULT_IPC_ACK_TIMEOUT_MS,
                    control.supervisorDisconnectController?.signal,
                  ),
            catch: () =>
              new Error("Private telemetry snapshot delivery failed"),
          }).pipe(
            Effect.catch(() =>
              Effect.sync(() => reportWorkerTelemetryDiagnostic()),
            ),
          );
        } catch {
          reportWorkerTelemetryDiagnostic();
        }
      }
      let exitCode = result.exitCode;
      const terminalFlushExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => result.events.flushDeferredTerminal(),
          catch: (cause) => cause,
        }),
      );
      if (Exit.isFailure(terminalFlushExit)) exitCode = 1;
      return exitCode;
    }).pipe(Effect.provideService(Metric.MetricRegistry, metricRegistry)),
  );
  if (spanCollector !== undefined) {
    workerProgram = workerProgram.pipe(
      Effect.provideService(Tracer.Tracer, spanCollector.tracer),
    );
  }
  const exitCode = await Effect.runPromise(workerProgram);
  // process.exit skips finalizers, so exit only after the queue scope closes.
  host.exit(exitCode);
}

async function startRunScoped(
  host: RunnerHost,
  request: RunRequest,
  createWorkId: () => string,
  createRunId: () => string,
  retainWorkflow: (workflow: LoadedWorkflow) => void,
  control: RunnerRunControl,
  resolveExecution: RuntimeExecutionResolver,
  createInvocationId: (_nodeId?: string) => string,
  queue: ByteBoundedEventQueue,
  lastAcknowledgedSequence: () => number,
  activeCarrier: TraceCarrier,
  encodedEvents: WeakMap<SeqlaneExecutionEvent, string>,
  ownedProcessRegistry: OwnedProcessRegistry,
): Promise<{
  readonly exitCode: 0 | 1;
  readonly events: ReturnType<typeof createExecutionEventBridge>;
}> {
  const abortController = new AbortController();
  control.abortController = abortController;
  const workId = createWorkId();
  const runId = createRunId();
  const ackTimeoutMs = control.ipcAckTimeoutMs ?? DEFAULT_IPC_ACK_TIMEOUT_MS;
  const events = createExecutionEventBridge(
    (event) =>
      sendEvent(host, control, event, ackTimeoutMs, encodedEvents.get(event)),
    {
      queue,
      lastAcknowledgedSequence,
      traceCarrier: activeCarrier,
      deferTerminalUntilTelemetry: true,
      encodedEvents,
    },
  );
  let runOutcome: EffectPlanRunResult | undefined;
  let ownershipReleaseFailed = false;

  try {
    await Effect.runPromise(
      events.emitEffect({ type: "run.started", workId, runId }),
    );
    const loadedWorkflow = await loadAndAnnounceWorkflow(
      request,
      workId,
      runId,
      retainWorkflow,
      events,
    );

    if (control.cancellationRequested) {
      await Effect.runPromise(
        events.emitEffect({ type: "run.cancelled", workId, runId }),
      );
      await events.flush();
      return { exitCode: 0, events };
    }

    if (request.dryRun) {
      await Effect.runPromise(
        events.emitEffect({
          type: "run.succeeded",
          workId,
          runId,
          output: null,
        }),
      );
      await events.flush();
      return { exitCode: 0, events };
    }

    const outcome = await settleRunProgram(
      createEffectPlanProgram({
        workflow: loadedWorkflow,
        input: request.input,
        workId,
        runId,
        signal: abortController.signal,
        events,
        createInvocationId,
        resolveExecution: (signal) =>
          Promise.resolve(
            resolveExecution(
              request.runtime,
              loadedWorkflow.taskDefinitions,
              signal,
              request.input,
              (notification) =>
                sendRuntimeSessionUi(host, control, notification, ackTimeoutMs),
              {
                runId,
                onOwnedProcessAcquired: (pid) =>
                  ownedProcessRegistry.register(pid),
              },
            ),
          ),
        onObservation: (event) => events.emitObservation(event),
        onDiagnostic: (message) => process.stderr.write(`${message}\n`),
      }),
      abortController.signal,
      activeCarrier,
      { tracer: control.tracer, metricRegistry: control.metricRegistry },
    );
    runOutcome = outcome;
    try {
      await ownedProcessRegistry.releaseStoppedProcesses();
    } catch (cause) {
      ownershipReleaseFailed = true;
      throw cause;
    }
    publishRunOutcome(events, workId, runId, outcome);
    await events.flush();
    return { exitCode: 0, events };
  } catch (cause) {
    // Accepted events settle before a terminal outcome bypasses the failed
    // queue. A broken IPC channel still exits nonzero for supervisor fallback.
    const deliveryFailure = await events.settle();
    const deliveryCause =
      deliveryFailure instanceof EventQueueDeliveryError
        ? deliveryFailure.cause
        : deliveryFailure;
    const primaryCause =
      runOutcome?.status === "failed"
        ? runOutcome.error
        : deliveryFailure === undefined
          ? cause
          : deliveryCause;
    const secondaryCauses = [
      ...(runOutcome?.status === "failed" ? [cause] : []),
      ...(deliveryFailure === undefined ? [] : [cause]),
    ].filter((secondary) => !hasCause(secondary, primaryCause));
    const terminal =
      control.cancellationRequested &&
      !ownershipReleaseFailed &&
      deliveryFailure === undefined &&
      (runOutcome === undefined || runOutcome.status === "cancelled")
        ? ({ type: "run.cancelled", workId, runId } as const)
        : ({
            type: "run.failed",
            workId,
            runId,
            error: new RuntimeError(
              withSecondaryRunCauses(primaryCause, secondaryCauses),
            ),
          } as const);
    let exitCode: 0 | 1 = deliveryFailure === undefined ? 0 : 1;
    try {
      await events.sendTerminal(terminal);
    } catch {
      exitCode = 1;
    }
    return { exitCode, events };
  }
}

async function loadAndAnnounceWorkflow(
  request: RunRequest,
  workId: string,
  runId: string,
  retainWorkflow: (workflow: LoadedWorkflow) => void,
  events: ReturnType<typeof createExecutionEventBridge>,
): Promise<LoadedWorkflow> {
  const workflow = await loadWorkflow(request.workflow);
  retainWorkflow(workflow);
  await Effect.runPromise(
    events.emitPlanEffect(
      createSeqlanePlanSnapshot(workflow.plan),
      workId,
      runId,
    ),
  );
  return workflow;
}
