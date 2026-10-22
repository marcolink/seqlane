import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import type {
  TelemetrySpanSnapshot,
  TelemetrySpanSnapshotFrame,
} from "@seqlane/protocol/private/telemetry-span-snapshot";
import {
  createCanonicalMetricRegistry,
  recordCanonicalMetric,
  recordQueuePressureMetrics,
  snapshotCanonicalMetrics,
} from "./canonical-metrics.js";
import {
  projectNativeObservationSpans,
  type NativeObservationProjection,
} from "./native-observation-projection.js";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 2_000;
type EventQueuePressure = NonNullable<
  TelemetrySpanSnapshotFrame["queuePressure"]
>;

export interface TelemetrySpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly status: "started" | "ended" | "error";
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly kind?: TelemetrySpanSnapshot["kind"];
  readonly links?: ReadonlyArray<{
    readonly traceId: string;
    readonly spanId: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }>;
  readonly startTimeUnixNano?: string;
  readonly endTimeUnixNano?: string;
}

export interface TelemetryLog {
  readonly timestamp: string;
  readonly severity: "INFO" | "ERROR";
  readonly body: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface TelemetryMetric {
  readonly name: string;
  readonly value: number;
  readonly attributes: Readonly<Record<string, string>>;
  readonly kind?: "sum" | "gauge";
}

export interface InProcessTelemetry {
  readonly record: (event: SeqlaneExecutionEvent) => void;
  readonly recordSpan: (span: TelemetrySpanSnapshot) => void;
  readonly recordDropped: (count: number) => void;
  readonly recordQueuePressure: (pressure: EventQueuePressure) => void;
  readonly recordLog: (log: TelemetryLog) => void;
  readonly snapshot: () => {
    readonly events: ReadonlyArray<SeqlaneExecutionEvent>;
    readonly spans: ReadonlyArray<TelemetrySpan>;
    readonly logs: ReadonlyArray<TelemetryLog>;
    readonly metrics: ReadonlyArray<TelemetryMetric>;
    readonly droppedRecords: number;
    readonly retainedBytes: number;
  };
}

function traceContext(event: SeqlaneExecutionEvent): {
  traceId?: string;
  parentSpanId?: string;
} {
  const carrier = event.metadata.traceparent;
  if (carrier === undefined) return {};
  const [, traceId, parentSpanId] = carrier.split("-");
  return { traceId, parentSpanId };
}

/** Bounded local collector. It retains whole accepted canonical records only. */
export function createInProcessTelemetry(
  options: {
    readonly maxBytes?: number;
    readonly maxRecords?: number;
  } = {},
): InProcessTelemetry {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1
  ) {
    throw new RangeError(
      "Telemetry collector limits must be positive safe integers",
    );
  }
  const events: Array<{ value: SeqlaneExecutionEvent; bytes: number }> = [];
  const logs: TelemetryLog[] = [];
  const capturedSpans: Array<{ value: TelemetrySpanSnapshot; bytes: number }> =
    [];
  let capturedSpanBytes = 0;
  let logsBytes = 0;
  const metricRegistry = createCanonicalMetricRegistry();
  let nativeProjectionCache = new Map<string, NativeObservationProjection>();
  let retainedBytes = 0;
  let droppedRecords = 0;

  return {
    recordLog(log) {
      const bytes = Buffer.byteLength(JSON.stringify(log), "utf8");
      if (bytes > maxBytes) {
        droppedRecords += 1;
        return;
      }
      while (
        logs.length > 0 &&
        (logs.length >= maxRecords || logsBytes + bytes > maxBytes)
      ) {
        const oldest = logs.shift();
        if (oldest !== undefined)
          logsBytes -= Buffer.byteLength(JSON.stringify(oldest), "utf8");
        droppedRecords += 1;
      }
      logs.push(log);
      logsBytes += bytes;
    },
    recordSpan(span) {
      const bytes = Buffer.byteLength(JSON.stringify(span), "utf8");
      if (bytes > maxBytes) {
        droppedRecords += 1;
        return;
      }
      while (
        capturedSpans.length > 0 &&
        (capturedSpans.length >= maxRecords ||
          capturedSpanBytes + bytes > maxBytes)
      ) {
        const oldest = capturedSpans.shift();
        if (oldest !== undefined) capturedSpanBytes -= oldest.bytes;
        droppedRecords += 1;
      }
      capturedSpans.push({ value: span, bytes });
      capturedSpanBytes += bytes;
    },
    recordDropped(count) {
      if (Number.isSafeInteger(count) && count > 0) droppedRecords += count;
    },
    recordQueuePressure(pressure) {
      recordQueuePressureMetrics(metricRegistry, pressure);
    },
    record(event) {
      const serialized = JSON.stringify(event);
      const bytes = Buffer.byteLength(serialized, "utf8");
      recordCanonicalMetric(metricRegistry, event, bytes);
      if (bytes > maxBytes) {
        droppedRecords += 1;
        return;
      }
      while (
        events.length > 0 &&
        (events.length >= maxRecords || retainedBytes + bytes > maxBytes)
      ) {
        const oldest = events.shift();
        if (oldest !== undefined) retainedBytes -= oldest.bytes;
        droppedRecords += 1;
      }
      events.push({ value: event, bytes });
      retainedBytes += bytes;

      if (
        event.type.startsWith("run.") ||
        event.type.startsWith("invocation.")
      ) {
        const { traceId, parentSpanId } = traceContext(event);
        this.recordLog({
          timestamp: event.metadata.occurredAt,
          severity: event.type.endsWith("failed") ? "ERROR" : "INFO",
          body: event.type,
          ...(traceId === undefined ? {} : { traceId }),
          ...(parentSpanId === undefined ? {} : { spanId: parentSpanId }),
          attributes: {
            "event.type": event.type,
            "event.sequence": event.metadata.sequence,
            ...(event.type.startsWith("invocation.")
              ? { "seqlane.invocation": 1 }
              : { "seqlane.run": 1 }),
          },
        });
      }
    },
    snapshot() {
      const metricRecords = snapshotCanonicalMetrics(metricRegistry);
      const projected = projectNativeObservationSpans(
        events.map((entry) => entry.value),
        nativeProjectionCache,
        capturedSpans.map(({ value }) => value),
      );
      nativeProjectionCache = projected.projections;
      const captured = capturedSpans.map(({ value }) => ({
        name: value.name,
        traceId: value.traceId,
        spanId: value.spanId,
        ...(value.parentSpanId === undefined
          ? {}
          : { parentSpanId: value.parentSpanId }),
        startTime: Number(BigInt(value.startTimeUnixNano) / 1_000_000n),
        endTime: Number(BigInt(value.endTimeUnixNano) / 1_000_000n),
        startTimeUnixNano: value.startTimeUnixNano,
        endTimeUnixNano: value.endTimeUnixNano,
        kind: value.kind,
        links: value.links,
        status:
          value.status === "error" ? ("error" as const) : ("ended" as const),
        attributes: value.attributes,
      }));
      return {
        events: events.map((entry) => entry.value),
        spans: [...captured, ...projected.spans],
        logs: [...logs],
        metrics: metricRecords,
        droppedRecords,
        retainedBytes,
      };
    },
  };
}
