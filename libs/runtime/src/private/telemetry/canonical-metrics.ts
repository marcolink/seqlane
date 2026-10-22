import { Context, Metric } from "effect";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import type { TelemetrySpanSnapshotFrame } from "@seqlane/protocol/private/telemetry-span-snapshot";
import type { TelemetryMetric } from "./collector.js";

const MAX_TRACKED_INVOCATIONS = 1_000;
const MAX_TRACKED_OBSERVATIONS = 1_000;
const MAX_TRACKED_ID_LENGTH = 512;
const HISTOGRAM_BOUNDARIES = [
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  5_000,
  Infinity,
];
const stateByRegistry = new WeakMap<
  Metric.MetricRegistry,
  CanonicalMetricState
>();

type Attributes = Readonly<Record<string, string>>;
type InvocationKind =
  "task" | "workflow" | "validator" | "choice" | "validation-gate" | "unknown";
type OmissionReason =
  | "invocation_id_untrackable"
  | "invocation_state_unavailable"
  | "invocation_capacity"
  | "observation_id_untrackable"
  | "observation_capacity";

interface InvocationState {
  kind: InvocationKind;
  startedAt?: number;
  waitingAt?: number;
  outputMetricsRecorded: boolean;
}

interface ObservationState {
  readonly kind: InvocationKind;
  readonly startedAt?: number;
  terminal: boolean;
}

interface ObservationRecordContext {
  readonly registry: Metric.MetricRegistry;
  readonly state: CanonicalMetricState;
  readonly invocationKey: string;
  readonly key: string;
  readonly observations: Map<string, ObservationState> | undefined;
  readonly kind: InvocationKind;
  readonly event: Extract<
    SeqlaneExecutionEvent,
    { type: "invocation.observation" }
  >;
}

/** Creates an isolated Effect metric registry for one run. */
export function createCanonicalMetricRegistry(): Metric.MetricRegistry {
  return new Map();
}

function metricContext(registry: Metric.MetricRegistry) {
  return Context.make(Metric.MetricRegistry, registry);
}

function increment(
  registry: Metric.MetricRegistry,
  name: string,
  value: number,
  attributes: Attributes = {},
): void {
  Metric.counter(name, { attributes }).updateUnsafe(
    value,
    metricContext(registry),
  );
}

function observe(
  registry: Metric.MetricRegistry,
  name: string,
  value: number,
  attributes: Attributes = {},
): void {
  Metric.histogram(name, {
    attributes,
    boundaries: HISTOGRAM_BOUNDARIES,
  }).updateUnsafe(value, metricContext(registry));
}

/** Records validated worker queue pressure in the per-run native registry. */
export function recordQueuePressureMetrics(
  registry: Metric.MetricRegistry,
  pressure: NonNullable<TelemetrySpanSnapshotFrame["queuePressure"]>,
): void {
  increment(
    registry,
    "seqlane.event_queue.capacity_waits",
    pressure.capacityWaitsTotal,
  );
  increment(registry, "seqlane.event_queue.overflows", pressure.overflowsTotal);
  for (const [name, value] of [
    ["seqlane.event_queue.pending_bytes_peak", pressure.pendingBytesPeak],
    ["seqlane.event_queue.capacity_bytes", pressure.maxPendingBytes],
  ] as const) {
    Metric.gauge(name).updateUnsafe(value, metricContext(registry));
  }
}

/** Records one actual signal export failure with a fixed-cardinality label. */
export function recordTelemetryExportFailure(
  registry: Metric.MetricRegistry,
  signal: "traces" | "logs" | "metrics",
): void {
  increment(registry, "seqlane.telemetry.export_failures", 1, { signal });
}

function metricKind(
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.started" }>,
): InvocationKind {
  switch (event.subject.type) {
    case "task":
    case "workflow":
    case "validator":
    case "choice":
    case "validation-gate":
      return event.subject.type;
  }
}

function subjectKind(subject: { readonly type: string }): InvocationKind {
  switch (subject.type) {
    case "task":
    case "workflow":
    case "validator":
    case "choice":
    case "validation-gate":
      return subject.type;
    default:
      return "unknown";
  }
}

function recordOmission(
  registry: Metric.MetricRegistry,
  reason: OmissionReason,
): void {
  increment(registry, "seqlane.telemetry.omissions", 1, { reason });
}

function timestamp(event: SeqlaneExecutionEvent): number {
  return Date.parse(event.metadata.occurredAt);
}

function elapsed(
  startedAt: number | undefined,
  endedAt: number,
): number | undefined {
  if (startedAt === undefined || endedAt < startedAt) return undefined;
  return endedAt - startedAt;
}

function eventIdKey(value: string): string | undefined {
  return value.length <= MAX_TRACKED_ID_LENGTH ? value : undefined;
}

function observationKey(
  observationId: string,
  attemptIndex: number | undefined,
): string | undefined {
  const observationKey = eventIdKey(observationId);
  if (observationKey === undefined) return undefined;
  return JSON.stringify([observationKey, attemptIndex ?? 0]);
}

function recordOutputMetrics(
  registry: Metric.MetricRegistry,
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.output" }>,
  kind: InvocationKind,
): void {
  const metrics = event.metrics;
  if (metrics === undefined) return;
  const attributes = { task_kind: kind };
  if (metrics.durationMs !== undefined) {
    observe(
      registry,
      "seqlane.invocation.reported_duration_ms",
      metrics.durationMs,
      attributes,
    );
  }
  if (metrics.cost !== undefined) {
    increment(registry, "seqlane.model.cost", metrics.cost, attributes);
  }
  if (metrics.tokens !== undefined) {
    const tokens = metrics.tokens;
    increment(registry, "seqlane.model.tokens", tokens.input, {
      ...attributes,
      token_type: "input",
    });
    increment(registry, "seqlane.model.tokens", tokens.output, {
      ...attributes,
      token_type: "output",
    });
    increment(registry, "seqlane.model.tokens", tokens.reasoning, {
      ...attributes,
      token_type: "reasoning",
    });
    increment(registry, "seqlane.model.tokens", tokens.cacheRead, {
      ...attributes,
      token_type: "cache_read",
    });
    increment(registry, "seqlane.model.tokens", tokens.cacheWrite, {
      ...attributes,
      token_type: "cache_write",
    });
    if (tokens.total !== undefined) {
      increment(registry, "seqlane.model.tokens", tokens.total, {
        ...attributes,
        token_type: "total",
      });
    }
  }
}

interface CanonicalMetricState {
  readonly invocations: Map<string, InvocationState>;
  readonly observations: Map<string, Map<string, ObservationState>>;
  observationCount: number;
  runStartedAt: number | undefined;
}

function stateFor(registry: Metric.MetricRegistry): CanonicalMetricState {
  // Weak keys keep bounded run-local state attached to the native registry
  // lifecycle without adding non-metric entries to Effect's registry.
  let state = stateByRegistry.get(registry);
  if (state === undefined) {
    state = {
      invocations: new Map(),
      observations: new Map(),
      observationCount: 0,
      runStartedAt: undefined,
    };
    stateByRegistry.set(registry, state);
  }
  return state;
}

function recordRunStarted(
  state: CanonicalMetricState,
  event: Extract<SeqlaneExecutionEvent, { type: "run.started" }>,
): void {
  state.runStartedAt ??= timestamp(event);
}

function recordRunTerminal(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<
    SeqlaneExecutionEvent,
    { type: "run.succeeded" | "run.failed" | "run.cancelled" }
  >,
): void {
  const outcome =
    event.type === "run.succeeded"
      ? "succeeded"
      : event.type === "run.failed"
        ? "failed"
        : "cancelled";
  increment(registry, "seqlane.runs", 1, { outcome });
  const duration = elapsed(state.runStartedAt, timestamp(event));
  if (duration !== undefined)
    observe(registry, "seqlane.run.duration_ms", duration, { outcome });
  state.runStartedAt = undefined;
}

function ensureInvocation(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  invocationId: string,
  kind: InvocationKind,
): InvocationState | undefined {
  const key = eventIdKey(invocationId);
  if (key === undefined) {
    recordOmission(registry, "invocation_id_untrackable");
    return undefined;
  }
  const existing = state.invocations.get(key);
  if (existing !== undefined) {
    if (kind !== "unknown") existing.kind = kind;
    return existing;
  }
  if (state.invocations.size >= MAX_TRACKED_INVOCATIONS) {
    recordOmission(registry, "invocation_capacity");
    return undefined;
  }
  const created: InvocationState = { kind, outputMetricsRecorded: false };
  state.invocations.set(key, created);
  return created;
}

function recordInvocationCreated(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.created" }>,
): void {
  ensureInvocation(
    registry,
    state,
    event.invocationId,
    subjectKind(event.subject),
  );
}

function recordInvocationStarted(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.started" }>,
): void {
  const invocation = ensureInvocation(
    registry,
    state,
    event.invocationId,
    metricKind(event),
  );
  if (invocation === undefined) return;
  const startedAt = timestamp(event);
  const waitDuration = elapsed(invocation.waitingAt, startedAt);
  if (waitDuration !== undefined) {
    observe(registry, "seqlane.invocation.wait_duration_ms", waitDuration, {
      task_kind: invocation.kind,
    });
  }
  invocation.waitingAt = undefined;
  invocation.startedAt ??= startedAt;
}

function recordInvocationProgress(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.progress" }>,
): void {
  const key = eventIdKey(event.invocationId);
  if (key === undefined) {
    recordOmission(registry, "invocation_id_untrackable");
    return;
  }
  const invocation =
    state.invocations.get(key) ??
    ensureInvocation(registry, state, event.invocationId, "unknown");
  if (invocation === undefined) return;
  const currentTime = timestamp(event);
  if (event.state === "waiting") {
    invocation.waitingAt ??= currentTime;
    return;
  }
  if (invocation.waitingAt === undefined) return;
  const duration = elapsed(invocation.waitingAt, currentTime);
  if (duration !== undefined)
    observe(registry, "seqlane.invocation.wait_duration_ms", duration, {
      task_kind: invocation.kind,
    });
  invocation.waitingAt = undefined;
}

function recordRetrying(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.retrying" }>,
): void {
  const key = eventIdKey(event.invocationId);
  if (key === undefined) recordOmission(registry, "invocation_id_untrackable");
  const kind =
    key === undefined
      ? "unknown"
      : (state.invocations.get(key)?.kind ?? "unknown");
  increment(registry, "seqlane.invocation.retries", 1, { task_kind: kind });
  if (event.delayMs !== undefined)
    observe(registry, "seqlane.invocation.retry_delay_ms", event.delayMs, {
      task_kind: kind,
    });
}

function recordOutput(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.output" }>,
): void {
  const key = eventIdKey(event.invocationId);
  const invocation = key === undefined ? undefined : state.invocations.get(key);
  if (event.metrics === undefined) return;
  if (key === undefined) {
    recordOmission(registry, "invocation_id_untrackable");
    return;
  }
  if (invocation === undefined) {
    recordOmission(
      registry,
      state.invocations.size >= MAX_TRACKED_INVOCATIONS
        ? "invocation_capacity"
        : "invocation_state_unavailable",
    );
    return;
  }
  if (invocation.outputMetricsRecorded) return;
  invocation.outputMetricsRecorded = true;
  recordOutputMetrics(registry, event, invocation?.kind ?? "unknown");
}

function recordObservationStarted(context: ObservationRecordContext): void {
  const { registry, state, invocationKey, key, observations, kind, event } =
    context;
  if (observations?.has(key) === true) return;
  if (state.observationCount >= MAX_TRACKED_OBSERVATIONS) {
    recordOmission(registry, "observation_capacity");
    return;
  }
  const tracked = observations ?? new Map<string, ObservationState>();
  tracked.set(key, {
    kind,
    startedAt: event.model.startedAt ?? timestamp(event),
    terminal: false,
  });
  state.observations.set(invocationKey, tracked);
  state.observationCount += 1;
  increment(registry, "seqlane.model.exchanges", 1, { task_kind: kind });
}

function recordObservationTerminal(context: ObservationRecordContext): void {
  const { registry, state, invocationKey, key, observations, kind, event } =
    context;
  if (
    event.state !== "succeeded" &&
    event.state !== "failed" &&
    event.state !== "cancelled"
  )
    return;
  const observation = observations?.get(key);
  if (observation?.terminal === true) return;
  if (
    observation === undefined &&
    state.observationCount >= MAX_TRACKED_OBSERVATIONS
  ) {
    recordOmission(registry, "observation_capacity");
    return;
  }
  if (observation === undefined)
    increment(registry, "seqlane.model.exchanges", 1, { task_kind: kind });
  const terminalKind = observation?.kind ?? kind;
  increment(registry, "seqlane.model.exchange_outcomes", 1, {
    task_kind: terminalKind,
    outcome: event.state,
  });
  const duration = elapsed(
    observation?.startedAt ?? event.model.startedAt,
    event.model.endedAt ?? timestamp(event),
  );
  if (duration !== undefined) {
    observe(registry, "seqlane.model.exchange.duration_ms", duration, {
      task_kind: terminalKind,
      outcome: event.state,
    });
  }
  if (observation !== undefined) {
    observation.terminal = true;
    return;
  }
  const tracked = observations ?? new Map<string, ObservationState>();
  tracked.set(key, { kind, terminal: true });
  state.observations.set(invocationKey, tracked);
  state.observationCount += 1;
}

function recordObservation(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.observation" }>,
): void {
  // ACP usage is cumulative session state, not per-call billing or exchange data.
  if (event.model.operation === "acp.session.usage") return;
  const invocationKey = eventIdKey(event.invocationId);
  const key = observationKey(event.observationId, event.attemptIndex);
  if (invocationKey === undefined) {
    recordOmission(registry, "invocation_id_untrackable");
    return;
  }
  if (key === undefined) {
    recordOmission(registry, "observation_id_untrackable");
    return;
  }
  const kind = state.invocations.get(invocationKey)?.kind ?? "unknown";
  const observations = state.observations.get(invocationKey);
  const context = {
    registry,
    state,
    invocationKey,
    key,
    observations,
    kind,
    event,
  };
  if (event.state === "started") {
    recordObservationStarted(context);
  } else {
    recordObservationTerminal(context);
  }
}

function terminalOutcome(
  event: Extract<
    SeqlaneExecutionEvent,
    {
      type:
        | "invocation.succeeded"
        | "invocation.failed"
        | "invocation.cancelled"
        | "invocation.skipped";
    }
  >,
): string {
  switch (event.type) {
    case "invocation.succeeded":
      return "succeeded";
    case "invocation.failed":
      return "failed";
    case "invocation.cancelled":
      return "cancelled";
    case "invocation.skipped":
      return "skipped";
  }
}

function recordInvocationTerminal(
  registry: Metric.MetricRegistry,
  state: CanonicalMetricState,
  event: Extract<
    SeqlaneExecutionEvent,
    {
      type:
        | "invocation.succeeded"
        | "invocation.failed"
        | "invocation.cancelled"
        | "invocation.skipped";
    }
  >,
): void {
  if (
    event.type === "invocation.failed" &&
    event.disposition === "retry_scheduled"
  )
    return;
  const key = eventIdKey(event.invocationId);
  if (key === undefined) recordOmission(registry, "invocation_id_untrackable");
  const invocation = key === undefined ? undefined : state.invocations.get(key);
  if (
    key !== undefined &&
    invocation === undefined &&
    state.invocations.size >= MAX_TRACKED_INVOCATIONS
  ) {
    recordOmission(registry, "invocation_capacity");
  }
  const kind = invocation?.kind ?? "unknown";
  const outcome = terminalOutcome(event);
  increment(registry, "seqlane.invocations", 1, { task_kind: kind, outcome });
  const currentTime = timestamp(event);
  const duration = elapsed(invocation?.startedAt, currentTime);
  if (duration !== undefined)
    observe(registry, "seqlane.invocation.duration_ms", duration, {
      task_kind: kind,
      outcome,
    });
  const waitDuration = elapsed(invocation?.waitingAt, currentTime);
  if (waitDuration !== undefined)
    observe(registry, "seqlane.invocation.wait_duration_ms", waitDuration, {
      task_kind: kind,
    });
  if (key === undefined) return;
  state.invocations.delete(key);
  const observations = state.observations.get(key);
  if (observations === undefined) return;
  state.observationCount -= observations.size;
  state.observations.delete(key);
}

/** Updates native Effect metrics from one already-validated canonical event. */
export function recordCanonicalMetric(
  registry: Metric.MetricRegistry,
  event: SeqlaneExecutionEvent,
  encodedBytes?: number,
): void {
  const state = stateFor(registry);
  if (
    encodedBytes !== undefined &&
    Number.isSafeInteger(encodedBytes) &&
    encodedBytes >= 0
  ) {
    increment(registry, "seqlane.event.payload_bytes", encodedBytes);
  }
  switch (event.type) {
    case "run.started":
      return recordRunStarted(state, event);
    case "run.succeeded":
    case "run.failed":
    case "run.cancelled":
      return recordRunTerminal(registry, state, event);
    case "invocation.created":
      return recordInvocationCreated(registry, state, event);
    case "invocation.started":
      return recordInvocationStarted(registry, state, event);
    case "invocation.progress":
      return recordInvocationProgress(registry, state, event);
    case "invocation.retrying":
      return recordRetrying(registry, state, event);
    case "invocation.output":
      return recordOutput(registry, state, event);
    case "invocation.observation":
      return recordObservation(registry, state, event);
    case "invocation.succeeded":
    case "invocation.failed":
    case "invocation.cancelled":
    case "invocation.skipped":
      return recordInvocationTerminal(registry, state, event);
    default:
      return;
  }
}

/** Snapshots native Effect metrics in the scalar shape consumed by the exporter. */
export function snapshotCanonicalMetrics(
  registry: Metric.MetricRegistry,
): ReadonlyArray<TelemetryMetric> {
  const context = metricContext(registry);
  const result: TelemetryMetric[] = [];
  for (const metric of Metric.snapshotUnsafe(context)) {
    const attributes = metric.attributes ?? {};
    if (metric.type === "Counter") {
      const value = Number(metric.state.count);
      if (Number.isFinite(value))
        result.push({ name: metric.id, value, attributes, kind: "sum" });
    } else if (metric.type === "Gauge") {
      const value = Number(metric.state.value);
      if (Number.isFinite(value))
        result.push({ name: metric.id, value, attributes, kind: "gauge" });
    } else if (metric.type === "Histogram") {
      result.push({
        name: `${metric.id}_sum`,
        value: metric.state.sum,
        attributes,
        kind: "sum",
      });
      result.push({
        name: `${metric.id}_count`,
        value: metric.state.count,
        attributes,
        kind: "sum",
      });
    }
  }
  return result;
}
