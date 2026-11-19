import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Latch,
  Scope,
  Semaphore,
  Tracer,
} from "effect";
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
import { settleRunProgramEffect } from "../execution/settle-run-program.js";
import { resolveRuntimeProfile } from "../../runner/profile/runtime-profile.js";
import { createExecutionEventBridge } from "../../runner/event-bridge.js";
import {
  createByteBoundedEventQueue,
  type ByteBoundedEventQueue,
} from "../../runner/byte-bounded-event-queue.js";
import { createNativeSpanCollector } from "../../private/telemetry/run-scope.js";
import { createInProcessTelemetry } from "../../private/telemetry/collector.js";
import { exportTelemetryEffect } from "../../private/telemetry/otlp-exporter.js";
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
  readonly outcome: Deferred.Deferred<OperationalRunStatus>;
  events: ReturnType<typeof createExecutionEventBridge>;
  readonly nativeCollector: ReturnType<typeof createNativeSpanCollector>;
  readonly telemetry: ReturnType<typeof createInProcessTelemetry>;
  readonly carrier: TraceCarrier;
  readonly scope: Scope.Closeable;
  readonly rootSpan: Tracer.Span;
  readonly queue: ByteBoundedEventQueue;
  scopeClosed: boolean;
  started: boolean;
  scheduled: boolean;
  cancellationRequested: boolean;
  deliveryFailure?: { readonly cause: unknown };
  status?: OperationalRunStatus;
}

export interface OperationalRunManager {
  readonly workflows: readonly OperationalWorkflow[];
  start(
    workflowKey: string,
    request: unknown,
  ): Effect.Effect<OperationalRunReference, unknown>;
  invoke(
    workflowKey: string,
    request: unknown,
  ): Effect.Effect<OperationalRunStatus, unknown>;
  status(runId: string): Effect.Effect<OperationalRunStatus, unknown>;
  list(request: unknown): ReturnType<OperationalStore["list"]>;
  events(
    runId: string,
    request: unknown,
  ): ReturnType<OperationalStore["events"]>;
  trace(runId: string): Effect.Effect<OperationalTraceInspection, unknown>;
  cancel(runId: string): Effect.Effect<OperationalRunCancel, unknown>;
  shutdown(): Effect.Effect<void, unknown>;
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

export class OperationalRunManagerService extends Context.Service<
  OperationalRunManagerService,
  OperationalRunManager
>()("seqlane/OperationalRunManager") {}

export function createOperationalRunManager(options: {
  readonly workflows: readonly OperationalWorkflowRegistration[];
  readonly store: OperationalStore;
  readonly classifierConnection?: PrivateClassifierConnection;
  readonly telemetryConfiguration?: TelemetryConfiguration;
}): Effect.Effect<OperationalRunManager, never, Scope.Scope> {
  return Effect.gen(function* () {
    const byKey = new Map(
      options.workflows.map((workflow) => [workflow.key, workflow]),
    );
    const byRunId = new Map<string, RunEntry>();
    const recentOutcomes = new Map<string, OperationalRunStatus>();
    const semaphore = yield* Semaphore.make(MAX_ACTIVE_RUNS);
    const fibers = yield* FiberMap.make<string, void, never>();
    const startsSettled = yield* Latch.make(true);
    let accepting = true;
    let outstanding = 0;
    let pendingStarts = 0;
    const now = Clock.currentTimeMillis.pipe(
      Effect.map((time) => new Date(time).toISOString()),
    );

    const releaseEntry = (entry: RunEntry, status: OperationalRunStatus) =>
      Effect.sync(() => {
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
        Deferred.doneUnsafe(entry.outcome, Effect.succeed(status));
      });

    const makeStatus = (
      entry: RunEntry,
      status: OperationalRunStatus["status"],
      updatedAt: string,
      result?: {
        readonly output?: JsonValue;
        readonly error?: unknown;
        readonly completeness?: OperationalRunStatus["completeness"];
      },
    ) =>
      operationalRunStatusSchema.parse({
        version: 1,
        workId: entry.reference.workId,
        runId: entry.reference.runId,
        workflowKey: entry.registration.key,
        status,
        createdAt: entry.referenceCreatedAt,
        updatedAt,
        ...(result?.output === undefined ? {} : { output: result.output }),
        ...(result?.error === undefined ? {} : { error: result.error }),
        completeness: result?.completeness ?? { inspection: "incomplete" },
      });

    const closeScope = (entry: RunEntry, outcome: SeqlaneRunOutcome) =>
      Effect.gen(function* () {
        if (entry.scopeClosed) return;
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
        yield* entry.queue.close().pipe(Effect.catchCause(() => Effect.void));
        yield* Scope.close(entry.scope, Exit.void);
        entry.scopeClosed = true;
      });

    const finishIncomplete = (
      entry: RunEntry,
      outcome: SeqlaneRunOutcome,
      cause: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const updatedAt = yield* now;
        const storageError = serializeSeqlaneError(
          cause instanceof Error ? cause : new RuntimeError(cause),
        );
        const normalized = yield* Effect.sync(() => ({
          outcome,
          output:
            outcome.status === "succeeded"
              ? jsonValueSchema.parse(outcome.result)
              : undefined,
          error:
            outcome.status === "failed"
              ? serializeSeqlaneError(outcome.error)
              : undefined,
        })).pipe(
          Effect.catchCause((cause) => {
            const error = new RuntimeError(Cause.squash(cause));
            return Effect.succeed({
              outcome: { status: "failed" as const, error },
              output: undefined,
              error: serializeSeqlaneError(error),
            });
          }),
        );
        const status = makeStatus(entry, normalized.outcome.status, updatedAt, {
          ...(normalized.output === undefined
            ? {}
            : { output: normalized.output }),
          ...(normalized.error === undefined
            ? {}
            : { error: normalized.error }),
          completeness: operationalRunCompletenessSchema.parse({
            inspection: "incomplete",
            storageError,
          }),
        });
        const inspection = yield* closeScope(entry, normalized.outcome).pipe(
          Effect.map(() => traceSnapshot(entry)),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );
        yield* options.store
          .markIncomplete({
            runId: entry.reference.runId,
            status: normalized.outcome.status,
            updatedAt,
            ...(normalized.output === undefined
              ? {}
              : { output: normalized.output }),
            ...(normalized.error === undefined
              ? {}
              : { error: normalized.error }),
            storageError: cause,
            ...(inspection === undefined
              ? {}
              : {
                  spans: inspection.spans,
                  droppedRecords: inspection.droppedRecords,
                }),
          })
          .pipe(Effect.catchCause(() => Effect.void));
        yield* releaseEntry(entry, status);
      });

    const finishOutcome = (
      entry: RunEntry,
      outcome: SeqlaneRunOutcome,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { workId, runId } = entry.reference;
        if (outcome.status === "succeeded")
          entry.events.emit({
            type: "run.succeeded",
            workId,
            runId,
            output: jsonValueSchema.parse(outcome.result),
          });
        else if (outcome.status === "cancelled")
          entry.events.emit({ type: "run.cancelled", workId, runId });
        else
          entry.events.emit({
            type: "run.failed",
            workId,
            runId,
            error: outcome.error,
          });
        // This drains acknowledgements, rather than merely emptying a Queue.
        yield* entry.queue.flush();
        yield* closeScope(entry, outcome);
        const inspection = traceSnapshot(entry);
        const updatedAt = yield* now;
        const output =
          outcome.status === "succeeded"
            ? jsonValueSchema.parse(outcome.result)
            : undefined;
        const error =
          outcome.status === "failed"
            ? serializeSeqlaneError(outcome.error)
            : undefined;
        const completeness =
          inspection.droppedRecords === 0
            ? { inspection: "complete" as const }
            : operationalRunCompletenessSchema.parse({
                inspection: "incomplete",
                storageError: serializeSeqlaneError(
                  new RuntimeError("Trace record retention limit reached"),
                ),
              });
        const status = makeStatus(entry, outcome.status, updatedAt, {
          ...(output === undefined ? {} : { output }),
          ...(error === undefined ? {} : { error }),
          completeness,
        });
        yield* options.store.completeRun({
          runId,
          status: outcome.status,
          updatedAt,
          ...(output === undefined ? {} : { output }),
          ...(error === undefined ? {} : { error }),
          spans: inspection.spans,
          droppedRecords: inspection.droppedRecords,
        });
        const telemetryConfiguration = options.telemetryConfiguration;
        if (telemetryConfiguration !== undefined)
          yield* exportTelemetryEffect(
            telemetryConfiguration,
            inspection.telemetry,
          ).pipe(Effect.catchCause(() => Effect.void));
        yield* releaseEntry(entry, status);
      }).pipe(
        Effect.catchCause((cause) =>
          finishIncomplete(
            entry,
            outcome,
            entry.deliveryFailure === undefined
              ? Cause.squash(cause)
              : entry.deliveryFailure.cause,
          ),
        ),
      );

    const executeEntry = (entry: RunEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        entry.started = true;
        if (entry.cancellationRequested)
          return yield* finishOutcome(entry, { status: "cancelled" });
        const outcome = yield* Effect.gen(function* () {
          yield* options.store.setRunning(entry.reference.runId, yield* now);
          const result = yield* settleRunProgramEffect(
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
          if (entry.deliveryFailure !== undefined)
            return {
              status: "failed" as const,
              error: new RuntimeError(entry.deliveryFailure.cause),
            };
          return result.status === "succeeded"
            ? { status: "succeeded" as const, result: result.output }
            : result;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed(
              entry.deliveryFailure !== undefined
                ? {
                    status: "failed" as const,
                    error: new RuntimeError(entry.deliveryFailure.cause),
                  }
                : entry.abortController.signal.aborted
                  ? { status: "cancelled" as const }
                  : {
                      status: "failed" as const,
                      error: new RuntimeError(Cause.squash(cause)),
                    },
            ),
          ),
        );
        yield* finishOutcome(entry, outcome);
      });

    const start = (
      workflowKey: string,
      rawRequest: unknown,
      admission?: { cancelled: boolean },
    ): Effect.Effect<OperationalRunReference, unknown> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!accepting) throw new Error("Operational host is closing");
          pendingStarts += 1;
          startsSettled.closeUnsafe();
          return yield* Effect.gen(function* () {
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
            const createdAt = yield* now;
            let inserted = false;
            let entry: RunEntry | undefined;
            let setupScope: Scope.Closeable | undefined;
            let setupQueue: ByteBoundedEventQueue | undefined;
            let deliveryFailure: { readonly cause: unknown } | undefined;
            return yield* Effect.gen(function* () {
              if (
                (yield* options.store.status(runId)) !== undefined ||
                byRunId.has(runId)
              )
                throw new OperationalRunConflictError(
                  runId,
                  new Error("Run identifier is already in use"),
                );
              yield* options.store.createRun({
                workId,
                runId,
                workflowKey,
                createdAt,
              });
              inserted = true;
              const nativeCollector = createNativeSpanCollector();
              const scope = yield* Scope.make();
              setupScope = scope;
              const rootSpan = yield* Effect.makeSpanScoped(
                "seqlane.hosted.run",
              ).pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.provideService(Tracer.Tracer, nativeCollector.tracer),
              );
              const carrier: TraceCarrier = {
                traceparent: `00-${rootSpan.traceId}-${rootSpan.spanId}-${rootSpan.sampled ? "01" : "00"}`,
              };
              const telemetry = createInProcessTelemetry({
                maxBytes: MAX_EVENT_BYTES,
                maxRecords: 2_000,
              });
              const outcome = yield* Deferred.make<OperationalRunStatus>();
              const abortController = new AbortController();
              const sourceSink = registration.source.eventSink?.({
                workId,
                runId,
              });
              const queue = yield* createByteBoundedEventQueue({
                maxPendingBytes: MAX_EVENT_BYTES,
                sendTimeoutMs: 5_000,
                onDeliveryFailure: (cause) => {
                  deliveryFailure = { cause };
                  if (entry !== undefined)
                    entry.deliveryFailure = deliveryFailure;
                  abortController.abort(cause);
                },
                send: (event) =>
                  Effect.sync(() => telemetry.record(event)).pipe(
                    Effect.andThen(options.store.appendEvent(runId, event)),
                  ),
              }).pipe(Effect.provideService(Scope.Scope, scope));
              setupQueue = queue;
              const clock = yield* Clock.Clock;
              const bridge = createExecutionEventBridge(async () => undefined, {
                maxPendingBytes: MAX_EVENT_BYTES,
                traceCarrier: carrier,
                queue,
                clock: () => new Date(clock.currentTimeMillisUnsafe()),
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
                        try: () => {
                          if (
                            event.type === "interaction.requested" ||
                            event.type === "interaction.response" ||
                            event.type === "interaction.resolved"
                          ) {
                            return;
                          }
                          sourceSink.emit(event);
                        },
                        catch: (cause) =>
                          cause instanceof Error
                            ? cause
                            : new Error("Operational event sink failed", {
                                cause,
                              }),
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
                events: bridge,
                nativeCollector,
                telemetry,
                carrier,
                scope,
                rootSpan,
                queue,
                scopeClosed: false,
                started: false,
                scheduled: false,
                cancellationRequested: false,
                ...(deliveryFailure === undefined ? {} : { deliveryFailure }),
              };
              setupScope = undefined;
              setupQueue = undefined;
              byRunId.set(runId, entry);
              sourceSink?.emitPlan(registration.planSnapshot, workId, runId);
              bridge.emit({ type: "run.started", workId, runId });
              bridge.emitPlan(registration.planSnapshot, workId, runId);
              yield* queue.flush();
              if (
                !accepting ||
                admission?.cancelled === true ||
                entry.cancellationRequested
              ) {
                entry.cancellationRequested = true;
                yield* finishOutcome(entry, { status: "cancelled" });
              } else {
                entry.scheduled = true;
                const scheduledEntry = entry;
                yield* FiberMap.run(
                  fibers,
                  runId,
                  semaphore
                    .withPermits(1)(Effect.uninterruptible(executeEntry(entry)))
                    .pipe(
                      Effect.interruptible,
                      Effect.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Effect.void
                          : finishIncomplete(
                              scheduledEntry,
                              {
                                status: "failed",
                                error: new RuntimeError(Cause.squash(cause)),
                              },
                              Cause.squash(cause),
                            ),
                      ),
                    ),
                  { startImmediately: false, onlyIfMissing: true },
                );
              }
              return reference;
            }).pipe(
              Effect.catchCause((failure) =>
                Effect.gen(function* () {
                  const cause = Cause.squash(failure);
                  if (setupQueue !== undefined)
                    yield* setupQueue
                      .close()
                      .pipe(Effect.catchCause(() => Effect.void));
                  if (setupScope !== undefined)
                    yield* Scope.close(setupScope, Exit.fail(cause)).pipe(
                      Effect.catchCause(() => Effect.void),
                    );
                  if (!inserted) outstanding = Math.max(0, outstanding - 1);
                  else if (entry !== undefined) {
                    const primary =
                      deliveryFailure === undefined
                        ? cause
                        : deliveryFailure.cause;
                    yield* finishIncomplete(
                      entry,
                      { status: "failed", error: new RuntimeError(primary) },
                      primary,
                    );
                  } else {
                    outstanding = Math.max(0, outstanding - 1);
                    yield* options.store
                      .markIncomplete({
                        runId,
                        status: "failed",
                        updatedAt: yield* now,
                        error: serializeSeqlaneError(new RuntimeError(cause)),
                        storageError: cause,
                      })
                      .pipe(Effect.catchCause(() => Effect.void));
                  }
                  if (inserted) return reference;
                  return yield* Effect.fail(cause);
                }),
              ),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pendingStarts -= 1;
                if (pendingStarts === 0) startsSettled.openUnsafe();
              }),
            ),
          );
        }),
      );

    const cancel = (
      runId: string,
    ): Effect.Effect<OperationalRunCancel, unknown> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const entry = byRunId.get(runId);
          if (entry === undefined || entry.status !== undefined) {
            const status =
              recentOutcomes.get(runId) ??
              entry?.status ??
              (yield* options.store.status(runId));
            if (status === undefined) throw new OperationalNotFoundError("run");
            return operationalRunCancelSchema.parse({
              version: 1,
              runId,
              status: status.status,
              cancellationRequested: false,
            });
          }
          const alreadyRequested = entry.cancellationRequested;
          entry.cancellationRequested = true;
          entry.abortController.abort();
          if (!alreadyRequested && !entry.started && entry.scheduled) {
            yield* FiberMap.remove(fibers, runId);
            if (!entry.started && entry.status === undefined)
              yield* finishOutcome(entry, { status: "cancelled" });
          }
          const status = yield* Deferred.await(entry.outcome);
          return operationalRunCancelSchema.parse({
            version: 1,
            runId,
            status: status.status,
            cancellationRequested: true,
          });
        }),
      );

    const shutdownProgram = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* startsSettled.await;
          const entries = [...byRunId.values()];
          const results = yield* Effect.forEach(
            entries,
            (entry) => Effect.exit(cancel(entry.reference.runId)),
            { concurrency: "unbounded" },
          );
          yield* FiberMap.clear(fibers);
          const failures = results
            .filter(Exit.isFailure)
            .map((exit) => Cause.squash(exit.cause));
          if (failures.length > 0)
            return yield* Effect.fail(
              new AggregateError(
                failures,
                "Operational run manager shutdown failed",
                { cause: failures[0] },
              ),
            );
        }),
      ),
    );
    const shutdown = () =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          accepting = false;
          return shutdownProgram;
        }),
      );

    const manager: OperationalRunManager = {
      workflows: operationalWorkflowListSchema.parse({
        version: 1,
        workflows: options.workflows.map(operationalWorkflow),
      }).workflows,
      start,
      invoke: (workflowKey, request) =>
        Effect.suspend(() => {
          const admission = { cancelled: false };
          return Effect.acquireUseRelease(
            Effect.gen(function* () {
              const acquired = yield* Deferred.make<
                OperationalRunReference,
                unknown
              >();
              const fiber = yield* Effect.forkChild(
                Effect.uninterruptible(
                  Effect.exit(start(workflowKey, request, admission)).pipe(
                    Effect.flatMap((exit) => Deferred.done(acquired, exit)),
                  ),
                ),
              );
              return { acquired, fiber };
            }),
            ({ acquired }) =>
              Effect.gen(function* () {
                const reference = yield* Deferred.await(acquired);
                const entry = byRunId.get(reference.runId);
                return yield* entry === undefined
                  ? manager.status(reference.runId)
                  : Deferred.await(entry.outcome);
              }),
            ({ acquired, fiber }) =>
              Effect.gen(function* () {
                admission.cancelled = true;
                const result = yield* Effect.exit(Deferred.await(acquired));
                if (Exit.isSuccess(result))
                  yield* cancel(result.value.runId).pipe(Effect.orDie);
                yield* Fiber.await(fiber);
              }),
          );
        }),
      status: (runId) =>
        Effect.gen(function* () {
          const recent =
            recentOutcomes.get(runId) ?? byRunId.get(runId)?.status;
          if (recent !== undefined) return recent;
          const status = yield* options.store.status(runId);
          if (status === undefined) throw new OperationalNotFoundError("run");
          return status;
        }),
      list: (rawRequest) =>
        Effect.suspend(() =>
          options.store.list(
            operationalRunListRequestSchema.parse({
              version: 1,
              ...recordOfUnknown(rawRequest),
            }),
          ),
        ),
      events: (runId, rawRequest) =>
        Effect.gen(function* () {
          const request = operationalRunEventsRequestSchema.parse({
            version: 1,
            ...recordOfUnknown(rawRequest),
          });
          const result = yield* options.store.events(runId, request);
          if (result === undefined) throw new OperationalNotFoundError("run");
          return result;
        }),
      trace: (runId) =>
        Effect.gen(function* () {
          const result = yield* options.store.trace(runId);
          if (result === undefined) throw new OperationalNotFoundError("run");
          return operationalTraceInspectionSchema.parse(result);
        }),
      cancel,
      shutdown,
    };
    yield* Effect.addFinalizer(() => shutdown().pipe(Effect.orDie));
    return manager;
  });
}
