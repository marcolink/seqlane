import { randomUUID } from "node:crypto";
import { Effect, Exit, Metric, Option, Tracer } from "effect";
import {
  encodeSeqlaneExecutionEvent,
  safeErrorMessage,
  type SeqlaneExecutionEvent,
  type InvocationObservationEvent,
} from "@seqlane/protocol";
import { RuntimeError } from "@seqlane/core";
import {
  publishRunOutcome,
  settleRunProgram,
} from "../runtime/execution/settle-run-program.js";
import type { EffectPlanRunResult } from "../runtime/execution/effect-plan.js";
import type { RunRequest } from "@seqlane/protocol";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import type { TelemetrySpanSnapshot } from "@seqlane/protocol/private/telemetry-span-snapshot";
import type { TelemetryConfiguration } from "../private/telemetry/configuration.js";
import { encodeTelemetrySpanSnapshotFrame } from "@seqlane/protocol/private/telemetry-span-snapshot";
import type { ExecutionEventSink } from "../runtime/execution/context.js";
import type { MastraActiveRun } from "../runtime/mastra/mastra-runtime.js";
import {
  createMastraPlanExecution,
  emitMastraInvocationTopology,
} from "../runtime/mastra/mastra-execution.js";
import { preflightCompiledWorkflowModels } from "../runtime/execution/model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../runtime/session/session-preflight.js";
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
  readonly ipcAckTimeoutMs?: number;
  readonly cancellationSettlementTimeoutMs?: number;
  readonly traceCarrier?: TraceCarrier;
  tracer?: Tracer.Tracer;
  metricRegistry?: Map<string, unknown>;
  readonly telemetryConfiguration?: TelemetryConfiguration;
  abortController?: AbortController;
  activeRun?: MastraActiveRun;
  runProgram?: RunnerRunProgram;
  cancellationSettlement?: Promise<void>;
  cancellationFailure?: { readonly cause: unknown };
  cancellationSettlementTimedOut?: boolean;
}

const CANCELLATION_SETTLEMENT_TIMEOUT_MS = 30_000;

export type RunnerRunProgramResult = EffectPlanRunResult;

/** Private composition seam for a worker-owned Plan program. */
export interface RunnerRunProgramContext {
  readonly workflow: LoadedWorkflow;
  readonly request: RunRequest;
  readonly workId: string;
  readonly runId: string;
  readonly traceCarrier?: TraceCarrier;
  readonly signal: AbortSignal;
  readonly events: ExecutionEventSink;
  readonly createInvocationId: (nodeId?: string) => string;
  readonly resolveExecution: (signal: AbortSignal) => Promise<RuntimeExecution>;
  readonly onObservation: (
    event: Omit<InvocationObservationEvent, "metadata">,
  ) => void;
}

export type RunnerRunProgram = (
  context: RunnerRunProgramContext,
) => Effect.Effect<RunnerRunProgramResult>;

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
  const activeRun = control.activeRun;
  if (activeRun !== undefined) {
    try {
      const settlement = Promise.resolve(activeRun.cancel()).then(
        () => undefined,
        (cause: unknown) => {
          control.cancellationFailure = { cause };
        },
      );
      const timeoutMs =
        control.cancellationSettlementTimeoutMs ??
        CANCELLATION_SETTLEMENT_TIMEOUT_MS;
      control.cancellationSettlement = Effect.runPromise(
        Effect.promise(() => settlement).pipe(Effect.timeoutOption(timeoutMs)),
      ).then((result) => {
        if (Option.isNone(result)) {
          control.cancellationSettlementTimedOut = true;
        }
      });
    } catch (cause) {
      control.cancellationFailure = { cause };
      control.cancellationSettlement = Promise.resolve();
    }
  }
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
  event: SeqlaneExecutionEvent,
  timeoutMs = DEFAULT_IPC_ACK_TIMEOUT_MS,
  acceptedEncoding?: string,
): Promise<void> {
  const encoded = acceptedEncoding ?? encodeSeqlaneExecutionEvent(event);
  return sendWithAcknowledgement(
    (callback) => host.send(encoded, callback),
    timeoutMs,
  );
}

function sendRuntimeSessionUi(
  host: RunnerHost,
  notification: RuntimeSessionUiAvailable,
  timeoutMs = DEFAULT_IPC_ACK_TIMEOUT_MS,
): Promise<void> {
  const encoded = encodeRuntimeSessionUiAvailable(notification);
  return sendWithAcknowledgement(
    (callback) => host.send(encoded, callback),
    timeoutMs,
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
              sendWithAcknowledgement(
                (callback) => host.send(encoded, callback),
                control.ipcAckTimeoutMs ?? DEFAULT_IPC_ACK_TIMEOUT_MS,
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
    (event) => sendEvent(host, event, ackTimeoutMs, encodedEvents.get(event)),
    {
      queue,
      lastAcknowledgedSequence,
      traceCarrier: activeCarrier,
      deferTerminalUntilTelemetry: true,
      encodedEvents,
    },
  );

  let execution: RuntimeExecution | undefined;
  let injectedRunFailure: unknown | undefined;

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

    if (control.runProgram !== undefined) {
      await executeInjectedRun(
        control,
        {
          workflow: loadedWorkflow,
          request,
          workId,
          runId,
          traceCarrier: activeCarrier,
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
                  sendRuntimeSessionUi(host, notification, ackTimeoutMs),
                { runId },
              ),
            ),
          onObservation: (event) => events.emitObservation(event),
        },
        (cause) => {
          injectedRunFailure = cause;
        },
      );
      return { exitCode: 0, events };
    }

    execution = await resolveExecution(
      request.runtime,
      loadedWorkflow.taskDefinitions,
      abortController.signal,
      request.input,
      (notification) => sendRuntimeSessionUi(host, notification, ackTimeoutMs),
      { runId },
      // The classifier connection is process-private startup state, never part
      // of the public runner command.
    );
    const mastraExecution = createMastraPlanExecution({
      plan: loadedWorkflow.plan,
      workId,
      runId,
      workflowInput: request.input,
      executors: execution.executors,
      sessionResolver: execution.sessionResolver,
      workspaceResources: execution.workspaceResources,
      taskDefinitions: execution.taskDefinitions,
      validatorDefinitions: loadedWorkflow.validatorDefinitions,
      workflowDefinitions: loadedWorkflow.workflowDefinitions,
      workflow: loadedWorkflow.workflow,
      events,
      onObservation: (event) => events.emitObservation(event),
      classifier: execution.classifier,
      createInvocationId,
    });
    // Topology is already compiled and does not depend on model/session
    // preflight. Emit it now so the interactive TUI is useful while a slow
    // executor setup is still in progress.
    emitMastraInvocationTopology(
      mastraExecution.compiled,
      mastraExecution.prepared,
      events,
    );
    preflightCompiledWorkflowSessionCapabilities(mastraExecution.prepared);
    await preflightCompiledWorkflowModels(mastraExecution.prepared);
    await resolveCompiledWorkflowSessions(mastraExecution.prepared);

    if (control.cancellationRequested) {
      await execution.close?.();
      execution = undefined;
      await Effect.runPromise(
        events.emitEffect({ type: "run.cancelled", workId, runId }),
      );
      await events.flush();
      return { exitCode: 0, events };
    }

    const activeRun = mastraExecution.runtime.start({
      workflowKey: mastraExecution.compiled.key,
      input: request.input,
      workId,
      runId,
    });
    control.activeRun = activeRun;
    if (control.cancellationRequested) await activeRun.cancel();
    const outcome = await activeRun.outcome;
    await execution.close?.();
    execution = undefined;
    publishRunOutcome(events, workId, runId, outcome);
    await events.flush();
    control.activeRun = undefined;
    return { exitCode: 0, events };
  } catch (cause) {
    await execution?.close?.().catch(() => undefined);
    await control.cancellationSettlement;
    // Accepted events settle before a terminal outcome bypasses the failed
    // queue. A broken IPC channel still exits nonzero for supervisor fallback.
    const deliveryFailure = await events.settle();
    const deliveryCause =
      deliveryFailure instanceof EventQueueDeliveryError
        ? deliveryFailure.cause
        : deliveryFailure;
    const primaryCause = deliveryFailure === undefined ? cause : deliveryCause;
    const secondaryCauses = [
      ...(deliveryFailure === undefined ? [] : [cause]),
      ...(injectedRunFailure === undefined ? [] : [injectedRunFailure]),
      ...(control.cancellationFailure === undefined
        ? []
        : [control.cancellationFailure.cause]),
      ...(control.cancellationSettlementTimedOut === true
        ? [
            new Error(
              `Adapter cancellation did not settle within ${control.cancellationSettlementTimeoutMs ?? CANCELLATION_SETTLEMENT_TIMEOUT_MS}ms; termination remains uncertain`,
            ),
          ]
        : []),
    ].filter((secondary) => !hasCause(secondary, primaryCause));
    const terminal =
      control.cancellationRequested &&
      control.activeRun === undefined &&
      deliveryFailure === undefined
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

async function executeInjectedRun(
  control: RunnerRunControl,
  context: Omit<RunnerRunProgramContext, "events"> & {
    readonly events: ReturnType<typeof createExecutionEventBridge>;
  },
  onFailure: (cause: unknown) => void,
): Promise<void> {
  const program = control.runProgram?.(context);
  if (program === undefined) return;
  const outcome = await settleRunProgram(
    program,
    context.signal,
    context.traceCarrier,
    {
      tracer: control.tracer,
      metricRegistry: control.metricRegistry,
    },
  );
  if (outcome.status === "failed") onFailure(outcome.error);
  publishRunOutcome(context.events, context.workId, context.runId, outcome);
  // Publication failures flow to startRun's single supervision fallback. It
  // settles accepted IPC events before sending one direct failure terminal.
  await context.events.flush();
}
