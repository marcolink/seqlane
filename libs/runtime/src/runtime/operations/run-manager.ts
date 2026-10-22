import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Fiber, Scope, Semaphore, Tracer } from "effect";
import {
  RuntimeError,
  jsonValueSchema,
  type JsonValue,
  type SeqlaneRunOutcome,
} from "@seqlane/core";
import {
  operationalRunCancelSchema,
  operationalRunEventsRequestSchema,
  operationalRunListRequestSchema,
  operationalRunReferenceSchema,
  operationalRunStartRequestSchema,
  operationalRunStatusSchema,
  operationalRunCompletenessSchema,
  operationalTraceInspectionSchema,
  operationalWorkflowListSchema,
  operationalWorkflowSchema,
  serializeSeqlaneError,
  type OperationalRunCancel,
  type OperationalRunReference,
  type OperationalRunStartRequest,
  type OperationalRunStatus,
  type OperationalTraceInspection,
  type OperationalWorkflow,
} from "@seqlane/protocol";
import {
  telemetrySpanSnapshotSchema,
  type TelemetrySpanSnapshot,
} from "@seqlane/protocol/private/telemetry-span-snapshot";
import { z } from "zod";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import type { PrivateClassifierConnection } from "../../classifier/types.js";
import { createEffectPlanProgram } from "../execution/effect-plan.js";
import { settleRunProgram } from "../execution/settle-run-program.js";
import { resolveRuntimeProfile } from "../../runner/profile/runtime-profile.js";
import { createExecutionEventBridge } from "../../runner/event-bridge.js";
import {
  createByteBoundedEventQueue,
  type ByteBoundedEventQueue,
} from "../../runner/byte-bounded-event-queue.js";
import { createNativeSpanCollector } from "../../private/telemetry/run-scope.js";
import { createInProcessTelemetry } from "../../private/telemetry/collector.js";
import { exportTelemetry } from "../../private/telemetry/otlp-exporter.js";
import type { OperationalWorkflowRegistration } from "./types.js";
import type { TelemetryConfiguration } from "../../private/telemetry/configuration.js";
import {
  OperationalRunConflictError,
  type OperationalStore,
} from "./sqlite-store.js";

const MAX_ACTIVE_RUNS = 4;
const MAX_QUEUED_RUNS = 16;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_TRACE_SPANS = 2_000;
const MAX_RECENT_OUTCOME_BYTES = 2 * 1024 * 1024;

export class OperationalAdmissionError extends Error {
  constructor() {
    super("Hosted run capacity is full");
    this.name = "OperationalAdmissionError";
  }
}

export class OperationalNotFoundError extends Error {
  constructor(readonly kind: "workflow" | "run") {
    super(`Operational ${kind} was not found`);
    this.name = "OperationalNotFoundError";
  }
}

interface RunEntry {
  readonly registration: OperationalWorkflowRegistration;
  readonly request: OperationalRunStartRequest;
  readonly reference: OperationalRunReference;
  readonly referenceCreatedAt: string;
  readonly abortController: AbortController;
  readonly outcome: Promise<OperationalRunStatus>;
  readonly resolveOutcome: (status: OperationalRunStatus) => void;
  events: ReturnType<typeof createExecutionEventBridge>;
  readonly nativeCollector: ReturnType<typeof createNativeSpanCollector>;
  readonly telemetry: ReturnType<typeof createInProcessTelemetry>;
  readonly carrier: TraceCarrier;
  readonly scope: Scope.Closeable;
  readonly rootSpan: Tracer.Span;
  readonly queue: ByteBoundedEventQueue;
  scopeClosed: boolean;
  started: boolean;
  cancellationRequested: boolean;
  deliveryFailure?: { readonly cause: unknown };
  status?: OperationalRunStatus;
  fiber?: Fiber.Fiber<void, never>;
}

export interface OperationalRunManager {
  readonly workflows: readonly OperationalWorkflow[];
  start(
    workflowKey: string,
    request: unknown,
  ): Promise<OperationalRunReference>;
  invoke(
    workflowKey: string,
    request: unknown,
  ): Effect.Effect<OperationalRunStatus, unknown>;
  status(runId: string): Promise<OperationalRunStatus>;
  list(request: unknown): ReturnType<OperationalStore["list"]>;
  events(
    runId: string,
    request: unknown,
  ): ReturnType<OperationalStore["events"]>;
  trace(runId: string): Promise<OperationalTraceInspection>;
  cancel(runId: string): Promise<OperationalRunCancel>;
  shutdown(): Promise<void>;
}

function schemaJson(schema: z.ZodType, io: "input" | "output"): JsonValue {
  const encoded = JSON.stringify(
    z.toJSONSchema(schema, { io, unrepresentable: "any" }),
  );
  if (encoded === undefined)
    throw new TypeError("Workflow schema is not JSON serializable");
  const decoded: unknown = JSON.parse(encoded);
  return jsonValueSchema.parse(decoded);
}

function operationalWorkflow(
  registration: OperationalWorkflowRegistration,
): OperationalWorkflow {
  const definition = registration.source.workflow ?? {
    input: z.unknown(),
    output: z.unknown(),
  };
  return operationalWorkflowSchema.parse({
    id: registration.source.plan.workflow.id,
    key: registration.key,
    input: {
      schema: schemaJson(definition.input, "input"),
      ...(definition.input.description === undefined
        ? {}
        : { description: definition.input.description }),
    },
    output: {
      schema: schemaJson(definition.output, "output"),
      ...(definition.output.description === undefined
        ? {}
        : { description: definition.output.description }),
    },
    plan: registration.planSnapshot,
  });
}

function recordOfUnknown(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

interface StartAdmission {
  cancellationRequested: boolean;
}

function acquireInvokeReference(
  start: () => Promise<OperationalRunReference>,
  cancel: (runId: string) => Promise<OperationalRunCancel>,
  admission: StartAdmission,
): Effect.Effect<OperationalRunReference, unknown> {
  let pending: Promise<OperationalRunReference> | undefined;
  const operation = Effect.tryPromise({
    try: () => (pending = start()),
    catch: (cause) => cause,
  });
  const interruptibleAcquisition = operation.pipe(
    Effect.interruptible,
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        admission.cancellationRequested = true;
      }),
    ),
  );
  return Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.exit(restore(interruptibleAcquisition)), (exit) => {
      if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
      return Effect.flatMap(
        Effect.promise(
          () =>
            pending?.then(
              (reference) => reference,
              () => undefined,
            ) ?? Promise.resolve(undefined),
        ),
        (reference) => {
          if (reference === undefined) return Effect.failCause(exit.cause);
          return Effect.flatMap(
            Effect.exit(
              Effect.tryPromise({
                try: () => cancel(reference.runId),
                catch: (cause) => cause,
              }),
            ),
            () => Effect.failCause(exit.cause),
          );
        },
      );
    }),
  );
}

function settleManagerPromise<A>(
  run: () => Promise<A>,
): Effect.Effect<A, unknown> {
  let pending: Promise<A> | undefined;
  const operation = Effect.tryPromise({
    try: () => (pending = run()),
    catch: (cause) => cause,
  });
  return Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.exit(restore(operation)), (exit) =>
      Effect.flatMap(
        Effect.promise(
          () =>
            pending?.then(
              () => undefined,
              () => undefined,
            ) ?? Promise.resolve(),
        ),
        () =>
          Effect.suspend(() =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : Effect.failCause(exit.cause),
          ),
      ),
    ),
  );
}

async function makeEventQueue(
  scope: Scope.Closeable,
  abortController: AbortController,
  store: OperationalStore,
  runId: string,
  telemetry: ReturnType<typeof createInProcessTelemetry>,
  onDeliveryFailure: (cause: unknown) => void,
): Promise<ByteBoundedEventQueue> {
  return Effect.runPromise(
    createByteBoundedEventQueue({
      maxPendingBytes: MAX_EVENT_BYTES,
      sendTimeoutMs: 5_000,
      onDeliveryFailure: (cause) => {
        onDeliveryFailure(cause);
        abortController.abort(cause);
      },
      send: (event) =>
        Effect.tryPromise({
          try: async () => {
            telemetry.record(event);
            await store.appendEvent(runId, event);
          },
          catch: (cause) => cause,
        }),
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
}

function traceSnapshot(entry: RunEntry): {
  readonly spans: readonly TelemetrySpanSnapshot[];
  readonly droppedRecords: number;
  readonly telemetry: ReturnType<
    ReturnType<typeof createInProcessTelemetry>["snapshot"]
  >;
} {
  const native = entry.nativeCollector.snapshot();
  for (const span of native.spans) entry.telemetry.recordSpan(span);
  entry.telemetry.recordDropped(native.droppedRecords);
  const projected = entry.telemetry.snapshot();
  const endedSpans = projected.spans.filter(
    (span) => span.endTimeUnixNano !== undefined || span.endTime !== undefined,
  );
  const spans: TelemetrySpanSnapshot[] = [];
  let retainedBytes = 0;
  let dropped =
    projected.droppedRecords + projected.spans.length - endedSpans.length;
  for (const span of endedSpans) {
    try {
      const snapshot = telemetrySpanSnapshotSchema.parse({
        name: span.name,
        traceId: span.traceId,
        spanId: span.spanId,
        ...(span.parentSpanId === undefined
          ? {}
          : { parentSpanId: span.parentSpanId }),
        startTimeUnixNano:
          span.startTimeUnixNano ??
          String(Math.round(span.startTime * 1_000_000)),
        endTimeUnixNano:
          span.endTimeUnixNano ?? String(Math.round(span.endTime! * 1_000_000)),
        kind: span.kind ?? "internal",
        status: span.status === "error" ? "error" : "ok",
        links: span.links ?? [],
        attributes: span.attributes,
      });
      const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
      if (
        spans.length >= MAX_TRACE_SPANS ||
        retainedBytes + bytes > MAX_TRACE_BYTES
      ) {
        dropped += 1;
      } else {
        spans.push(snapshot);
        retainedBytes += bytes;
      }
    } catch {
      dropped += 1;
    }
  }
  return { spans, droppedRecords: dropped, telemetry: projected };
}

export function createOperationalRunManager(options: {
  readonly workflows: readonly OperationalWorkflowRegistration[];
  readonly store: OperationalStore;
  readonly classifierConnection?: PrivateClassifierConnection;
  readonly telemetryConfiguration?: TelemetryConfiguration;
}): OperationalRunManager {
  const byKey = new Map(
    options.workflows.map((workflow) => [workflow.key, workflow]),
  );
  const byRunId = new Map<string, RunEntry>();
  const recentOutcomes = new Map<string, OperationalRunStatus>();
  const semaphore = Effect.runSync(Semaphore.make(MAX_ACTIVE_RUNS));
  const managerScope = Scope.makeUnsafe();
  let accepting = true;
  let outstanding = 0;
  let pendingStarts = 0;
  let resolvePendingStarts: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const waitForPendingStarts = (): Promise<void> =>
    pendingStarts === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          resolvePendingStarts = resolve;
        });

  const releaseEntry = (
    entry: RunEntry,
    status: OperationalRunStatus,
  ): void => {
    if (entry.status !== undefined) return;
    entry.status = status;
    outstanding = Math.max(0, outstanding - 1);
    byRunId.delete(entry.reference.runId);
    const statusBytes = Buffer.byteLength(JSON.stringify(status), "utf8");
    if (
      status.completeness.inspection === "incomplete" &&
      statusBytes <= MAX_RECENT_OUTCOME_BYTES
    ) {
      recentOutcomes.set(entry.reference.runId, status);
      while (recentOutcomes.size > 20)
        recentOutcomes.delete(recentOutcomes.keys().next().value!);
    }
    entry.resolveOutcome(status);
  };

  const makeStatus = (
    entry: RunEntry,
    status: OperationalRunStatus["status"],
    updatedAt: string,
    options?: {
      readonly output?: JsonValue;
      readonly error?: unknown;
      readonly completeness?: OperationalRunStatus["completeness"];
    },
  ): OperationalRunStatus =>
    operationalRunStatusSchema.parse({
      version: 1,
      workId: entry.reference.workId,
      runId: entry.reference.runId,
      workflowKey: entry.registration.key,
      status,
      createdAt: entry.referenceCreatedAt,
      updatedAt,
      ...(options?.output === undefined ? {} : { output: options.output }),
      ...(options?.error === undefined ? {} : { error: options.error }),
      completeness: options?.completeness ?? { inspection: "incomplete" },
    });

  async function closeScope(
    entry: RunEntry,
    outcome?: SeqlaneRunOutcome,
  ): Promise<void> {
    if (entry.scopeClosed) return;
    if (outcome !== undefined)
      entry.rootSpan.attribute("seqlane.outcome", outcome.status);
    const pressure = entry.queue.snapshotPressure();
    entry.rootSpan.attribute(
      "seqlane.event_queue.pending_bytes_peak",
      pressure.pendingBytesPeak,
    );
    entry.rootSpan.attribute(
      "seqlane.event_queue.capacity_waits_total",
      pressure.capacityWaitsTotal,
    );
    try {
      await Effect.runPromise(entry.queue.close());
    } catch {
      /* A delivery failure is represented as incomplete history. */
    }
    await Effect.runPromise(Scope.close(entry.scope, Exit.succeed(undefined)));
    entry.scopeClosed = true;
  }

  async function finishIncomplete(
    entry: RunEntry,
    outcome: SeqlaneRunOutcome,
    cause: unknown,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    const storageError = serializeSeqlaneError(
      cause instanceof Error ? cause : new RuntimeError(cause),
    );
    let durableOutcome = outcome;
    let output: JsonValue | undefined;
    let error: ReturnType<typeof serializeSeqlaneError> | undefined;
    try {
      if (outcome.status === "succeeded")
        output = jsonValueSchema.parse(outcome.result);
      if (outcome.status === "failed")
        error = serializeSeqlaneError(outcome.error);
    } catch (cause) {
      durableOutcome = { status: "failed", error: new RuntimeError(cause) };
      error = serializeSeqlaneError(durableOutcome.error);
    }
    const status = makeStatus(entry, durableOutcome.status, updatedAt, {
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      completeness: operationalRunCompletenessSchema.parse({
        inspection: "incomplete",
        storageError,
      }),
    });
    let spans: readonly TelemetrySpanSnapshot[] | undefined;
    let droppedRecords: number | undefined;
    try {
      await closeScope(entry, durableOutcome);
      const inspection = traceSnapshot(entry);
      spans = inspection.spans;
      droppedRecords = inspection.droppedRecords;
    } catch {
      // Preserve the task outcome and storage failure even when trace collection also fails.
    }
    try {
      await options.store.markIncomplete({
        runId: entry.reference.runId,
        status: durableOutcome.status,
        updatedAt,
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }),
        storageError: cause,
        ...(spans === undefined ? {} : { spans }),
        ...(droppedRecords === undefined ? {} : { droppedRecords }),
      });
    } catch {
      // Preserve the task outcome in memory if the database is unavailable.
    }
    releaseEntry(entry, status);
  }

  async function finishOutcome(
    entry: RunEntry,
    outcome: SeqlaneRunOutcome,
  ): Promise<void> {
    const { reference, events } = entry;
    try {
      if (outcome.status === "succeeded") {
        events.emit({
          type: "run.succeeded",
          workId: reference.workId,
          runId: reference.runId,
          output: jsonValueSchema.parse(outcome.result),
        });
      } else if (outcome.status === "cancelled") {
        events.emit({
          type: "run.cancelled",
          workId: reference.workId,
          runId: reference.runId,
        });
      } else {
        events.emit({
          type: "run.failed",
          workId: reference.workId,
          runId: reference.runId,
          error: outcome.error,
        });
      }
      await events.flush();
    } catch (cause) {
      await finishIncomplete(
        entry,
        outcome,
        entry.deliveryFailure === undefined
          ? cause
          : entry.deliveryFailure.cause,
      );
      return;
    }

    let inspection: ReturnType<typeof traceSnapshot>;
    try {
      await closeScope(entry, outcome);
      inspection = traceSnapshot(entry);
    } catch (cause) {
      await finishIncomplete(entry, outcome, cause);
      return;
    }
    const updatedAt = new Date().toISOString();
    const completeness =
      inspection.droppedRecords === 0
        ? { inspection: "complete" as const }
        : operationalRunCompletenessSchema.parse({
            inspection: "incomplete",
            storageError: serializeSeqlaneError(
              new RuntimeError("Trace record retention limit reached"),
            ),
          });
    try {
      const output =
        outcome.status === "succeeded"
          ? jsonValueSchema.parse(outcome.result)
          : undefined;
      const error =
        outcome.status === "failed"
          ? serializeSeqlaneError(outcome.error)
          : undefined;
      const status = makeStatus(entry, outcome.status, updatedAt, {
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }),
        completeness,
      });
      await options.store.completeRun({
        runId: reference.runId,
        status: outcome.status,
        updatedAt,
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }),
        spans: inspection.spans,
        droppedRecords: inspection.droppedRecords,
      });
      if (options.telemetryConfiguration !== undefined) {
        try {
          await exportTelemetry(
            options.telemetryConfiguration,
            inspection.telemetry,
          );
        } catch {
          // Export failure cannot overwrite the locally durable task outcome or trace.
        }
      }
      releaseEntry(entry, status);
    } catch (cause) {
      await finishIncomplete(entry, outcome, cause);
    }
  }

  async function executeEntry(entry: RunEntry): Promise<void> {
    entry.started = true;
    if (entry.cancellationRequested) {
      await finishQueuedCancellation(entry);
      return;
    }
    let outcome: SeqlaneRunOutcome;
    try {
      await options.store.setRunning(
        entry.reference.runId,
        new Date().toISOString(),
      );
      const result = await settleRunProgram(
        Effect.withParentSpan(
          createEffectPlanProgram({
            workflow: entry.registration.workflow,
            input: entry.request.input,
            workId: entry.reference.workId,
            runId: entry.reference.runId,
            signal: entry.abortController.signal,
            events: entry.events,
            createInvocationId: () => randomUUID(),
            resolveExecution: (signal) =>
              resolveRuntimeProfile(
                entry.request.runtime ?? {
                  id: entry.registration.defaultRuntimeId,
                },
                entry.registration.source.taskDefinitions,
                signal,
                entry.request.input,
                entry.registration.source.onSessionUiAvailable,
                {
                  runId: entry.reference.runId,
                  agentRuntime: entry.registration.source.agentRuntime,
                  classifierConnection: options.classifierConnection,
                },
              ),
            onObservation: (event) => entry.events.emitObservation(event),
          }),
          entry.rootSpan,
        ),
        entry.abortController.signal,
        entry.carrier,
        {
          tracer: entry.nativeCollector.tracer,
          metricRegistry: new Map<string, unknown>(),
        },
      );
      outcome =
        result.status === "succeeded"
          ? entry.deliveryFailure === undefined
            ? { status: "succeeded", result: result.output }
            : {
                status: "failed",
                error: new RuntimeError(entry.deliveryFailure.cause),
              }
          : result.status === "failed"
            ? { status: "failed", error: result.error }
            : entry.deliveryFailure === undefined
              ? { status: "cancelled" }
              : {
                  status: "failed",
                  error: new RuntimeError(entry.deliveryFailure.cause),
                };
    } catch (cause) {
      outcome =
        entry.deliveryFailure !== undefined
          ? {
              status: "failed",
              error: new RuntimeError(entry.deliveryFailure.cause),
            }
          : entry.abortController.signal.aborted
            ? { status: "cancelled" }
            : { status: "failed", error: new RuntimeError(cause) };
    }
    await finishOutcome(entry, outcome);
  }

  async function finishQueuedCancellation(
    entry: RunEntry,
  ): Promise<OperationalRunStatus> {
    const now = new Date().toISOString();
    try {
      entry.events.emit({
        type: "run.cancelled",
        workId: entry.reference.workId,
        runId: entry.reference.runId,
      });
      await entry.events.flush();
      await closeScope(entry, { status: "cancelled" });
      const inspection = traceSnapshot(entry);
      await options.store.completeRun({
        runId: entry.reference.runId,
        status: "cancelled",
        updatedAt: now,
        spans: inspection.spans,
        droppedRecords: inspection.droppedRecords,
      });
      const status = makeStatus(entry, "cancelled", now, {
        completeness:
          inspection.droppedRecords === 0
            ? { inspection: "complete" }
            : operationalRunCompletenessSchema.parse({
                inspection: "incomplete",
                storageError: serializeSeqlaneError(
                  new RuntimeError("Trace record retention limit reached"),
                ),
              }),
      });
      releaseEntry(entry, status);
      return status;
    } catch (cause) {
      await finishIncomplete(entry, { status: "cancelled" }, cause);
      return entry.status!;
    }
  }

  async function start(
    workflowKey: string,
    rawRequest: unknown,
    admission?: StartAdmission,
  ): Promise<OperationalRunReference> {
    if (!accepting) throw new Error("Operational host is closing");
    pendingStarts += 1;
    try {
      const registration = byKey.get(workflowKey);
      if (registration === undefined)
        throw new OperationalNotFoundError("workflow");
      const request = operationalRunStartRequestSchema.parse(rawRequest);
      const workId = request.workId ?? randomUUID();
      const runId = request.runId ?? randomUUID();
      if (outstanding >= MAX_ACTIVE_RUNS + MAX_QUEUED_RUNS)
        throw new OperationalAdmissionError();
      outstanding += 1;
      const reference = operationalRunReferenceSchema.parse({
        version: 1,
        workId,
        runId,
        status: "queued",
      });
      const createdAt = new Date().toISOString();
      let inserted = false;
      let entry: RunEntry | undefined;
      let setupScope: Scope.Closeable | undefined;
      let setupQueue: ByteBoundedEventQueue | undefined;
      let deliveryFailure: { readonly cause: unknown } | undefined;
      try {
        if (
          (await options.store.status(runId)) !== undefined ||
          byRunId.has(runId)
        )
          throw new OperationalRunConflictError(
            runId,
            new Error("Run identifier is already in use"),
          );
        await options.store.createRun({
          workId,
          runId,
          workflowKey,
          createdAt,
        });
        inserted = true;

        const nativeCollector = createNativeSpanCollector();
        const scope = await Effect.runPromise(Scope.make());
        setupScope = scope;
        const rootSpan = await Effect.runPromise(
          Effect.makeSpanScoped("seqlane.hosted.run").pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(Tracer.Tracer, nativeCollector.tracer),
          ),
        );
        const carrier: TraceCarrier = {
          traceparent: `00-${rootSpan.traceId}-${rootSpan.spanId}-${rootSpan.sampled ? "01" : "00"}`,
        };
        const telemetry = createInProcessTelemetry({
          maxBytes: MAX_EVENT_BYTES,
          maxRecords: 2_000,
        });
        let resolveOutcome!: (status: OperationalRunStatus) => void;
        const outcome = new Promise<OperationalRunStatus>((resolve) => {
          resolveOutcome = resolve;
        });
        const abortController = new AbortController();
        const sourceSink = registration.source.eventSink?.({ workId, runId });
        const queue = await makeEventQueue(
          scope,
          abortController,
          options.store,
          runId,
          telemetry,
          (cause) => {
            const failure = { cause };
            deliveryFailure = failure;
            if (entry !== undefined) entry.deliveryFailure = failure;
          },
        );
        setupQueue = queue;
        const bridge = createExecutionEventBridge(async () => undefined, {
          maxPendingBytes: MAX_EVENT_BYTES,
          traceCarrier: carrier,
          queue,
        });
        if (sourceSink !== undefined) {
          const emit = bridge.emit.bind(bridge);
          bridge.emit = (event) => {
            emit(event);
            sourceSink.emit(event);
          };
          const emitEffect = bridge.emitEffect.bind(bridge);
          bridge.emitEffect = (event) =>
            emitEffect(event).pipe(
              Effect.andThen(
                Effect.try({
                  try: () => sourceSink.emit(event),
                  catch: (cause) =>
                    cause instanceof Error
                      ? cause
                      : new Error("Operational event sink failed", { cause }),
                }),
              ),
            );
        }
        entry = {
          registration,
          request,
          reference,
          referenceCreatedAt: createdAt,
          abortController,
          outcome,
          resolveOutcome,
          events: bridge,
          nativeCollector,
          telemetry,
          carrier,
          scope,
          rootSpan,
          queue,
          scopeClosed: false,
          started: false,
          cancellationRequested: false,
          ...(deliveryFailure === undefined ? {} : { deliveryFailure }),
        };
        setupScope = undefined;
        setupQueue = undefined;
        byRunId.set(runId, entry);
        sourceSink?.emitPlan(registration.planSnapshot, workId, runId);
        bridge.emit({ type: "run.started", workId, runId });
        bridge.emitPlan(registration.planSnapshot, workId, runId);
        await bridge.flush();
        if (
          !accepting ||
          admission?.cancellationRequested === true ||
          entry.cancellationRequested
        ) {
          entry.cancellationRequested = true;
          await finishQueuedCancellation(entry);
          return reference;
        }
        entry.fiber = await Effect.runPromise(
          Effect.forkScoped(
            semaphore.withPermits(1)(
              settleManagerPromise(() => executeEntry(entry!)).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.promise(() =>
                        finishIncomplete(
                          entry!,
                          {
                            status: "failed",
                            error: new RuntimeError(Cause.squash(cause)),
                          },
                          Cause.squash(cause),
                        ),
                      ),
                ),
              ),
            ),
          ).pipe(Effect.provideService(Scope.Scope, managerScope)),
        );
        if (entry.cancellationRequested) {
          await Effect.runPromise(Fiber.interrupt(entry.fiber));
          if (!entry.started) await finishQueuedCancellation(entry);
          else await entry.outcome;
        }
        return reference;
      } catch (cause) {
        try {
          if (setupQueue !== undefined)
            await Effect.runPromise(setupQueue.close());
        } catch {
          /* Preserve the setup failure. */
        }
        try {
          if (setupScope !== undefined)
            await Effect.runPromise(Scope.close(setupScope, Exit.fail(cause)));
        } catch {
          /* Preserve the setup failure. */
        }
        if (!inserted) outstanding = Math.max(0, outstanding - 1);
        else if (entry !== undefined) {
          const failure =
            deliveryFailure === undefined ? { cause } : deliveryFailure;
          await finishIncomplete(
            entry,
            { status: "failed", error: new RuntimeError(failure.cause) },
            failure.cause,
          );
        } else {
          outstanding = Math.max(0, outstanding - 1);
          try {
            await options.store.markIncomplete({
              runId,
              status: "failed",
              updatedAt: new Date().toISOString(),
              error: serializeSeqlaneError(new RuntimeError(cause)),
              storageError: cause,
            });
          } catch {
            /* Startup failure remains visible through storage health. */
          }
        }
        if (inserted) return reference;
        throw cause;
      }
    } finally {
      pendingStarts -= 1;
      if (pendingStarts === 0) {
        resolvePendingStarts?.();
        resolvePendingStarts = undefined;
      }
    }
  }

  async function cancel(runId: string): Promise<OperationalRunCancel> {
    const entry = byRunId.get(runId);
    const recent = recentOutcomes.get(runId);
    if (entry === undefined) {
      if (recent !== undefined)
        return operationalRunCancelSchema.parse({
          version: 1,
          runId,
          status: recent.status,
          cancellationRequested: false,
        });
      const status = await options.store.status(runId);
      if (status === undefined) throw new OperationalNotFoundError("run");
      return operationalRunCancelSchema.parse({
        version: 1,
        runId,
        status: status.status,
        cancellationRequested: false,
      });
    }
    if (entry.status !== undefined)
      return operationalRunCancelSchema.parse({
        version: 1,
        runId,
        status: entry.status.status,
        cancellationRequested: false,
      });
    if (entry.cancellationRequested) {
      const status = await entry.outcome;
      return operationalRunCancelSchema.parse({
        version: 1,
        runId,
        status: status.status,
        cancellationRequested: true,
      });
    }
    entry.cancellationRequested = true;
    if (!entry.started && entry.fiber !== undefined) {
      entry.abortController.abort();
      await Effect.runPromise(Fiber.interrupt(entry.fiber));
      if (entry.started) {
        const status = await entry.outcome;
        return operationalRunCancelSchema.parse({
          version: 1,
          runId,
          status: status.status,
          cancellationRequested: true,
        });
      }
      const status = await finishQueuedCancellation(entry);
      return operationalRunCancelSchema.parse({
        version: 1,
        runId,
        status: status.status,
        cancellationRequested: true,
      });
    }
    entry.abortController.abort();
    const status = await entry.outcome;
    return operationalRunCancelSchema.parse({
      version: 1,
      runId,
      status: status.status,
      cancellationRequested: true,
    });
  }

  const manager: OperationalRunManager = {
    workflows: operationalWorkflowListSchema.parse({
      version: 1,
      workflows: options.workflows.map(operationalWorkflow),
    }).workflows,
    start,
    invoke: (workflowKey, request) => {
      const admission: StartAdmission = { cancellationRequested: false };
      return Effect.acquireUseRelease(
        acquireInvokeReference(
          () => start(workflowKey, request, admission),
          cancel,
          admission,
        ),
        (reference) =>
          Effect.tryPromise({
            try: async () => {
              const entry = byRunId.get(reference.runId);
              if (entry !== undefined) return await entry.outcome;
              return await manager.status(reference.runId);
            },
            catch: (cause) => cause,
          }),
        (reference) =>
          Effect.tryPromise({
            try: () => cancel(reference.runId),
            catch: (cause) => cause,
          }).pipe(Effect.asVoid),
      );
    },
    status: async (runId) => {
      const entry = byRunId.get(runId);
      if (entry?.status !== undefined) return entry.status;
      const recent = recentOutcomes.get(runId);
      if (recent !== undefined) return recent;
      const status = await options.store.status(runId);
      if (status === undefined) throw new OperationalNotFoundError("run");
      return status;
    },
    list: async (rawRequest) =>
      options.store.list(
        operationalRunListRequestSchema.parse({
          version: 1,
          ...recordOfUnknown(rawRequest),
        }),
      ),
    events: async (runId, rawRequest) => {
      const request = operationalRunEventsRequestSchema.parse({
        version: 1,
        ...recordOfUnknown(rawRequest),
      });
      const result = await options.store.events(runId, request);
      if (result === undefined) throw new OperationalNotFoundError("run");
      return result;
    },
    trace: async (runId) => {
      const result = await options.store.trace(runId);
      if (result === undefined) throw new OperationalNotFoundError("run");
      return operationalTraceInspectionSchema.parse(result);
    },
    cancel,
    shutdown: () => {
      if (shutdownPromise !== undefined) return shutdownPromise;
      accepting = false;
      shutdownPromise = (async () => {
        await waitForPendingStarts();
        const entries = [...byRunId.values()].filter(
          (entry) => entry.status === undefined,
        );
        const failures: { readonly cause: unknown }[] = [];
        const cancelResults = await Promise.allSettled(
          entries.map((entry) => cancel(entry.reference.runId)),
        );
        for (const result of cancelResults)
          if (result.status === "rejected")
            failures.push({ cause: result.reason });
        const outcomeResults = await Promise.allSettled(
          entries.map((entry) => entry.outcome),
        );
        for (const result of outcomeResults)
          if (result.status === "rejected")
            failures.push({ cause: result.reason });
        try {
          await Effect.runPromise(
            Scope.close(managerScope, Exit.succeed(undefined)),
          );
        } catch (cause) {
          failures.push({ cause });
        }
        if (failures.length > 0) {
          const [primary, ...secondary] = failures;
          throw new AggregateError(
            [primary!.cause, ...secondary.map(({ cause }) => cause)],
            "Operational run manager shutdown failed",
            { cause: primary!.cause },
          );
        }
      })();
      return shutdownPromise;
    },
  };
  return manager;
}
