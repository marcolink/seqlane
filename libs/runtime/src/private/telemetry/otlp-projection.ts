import { OtlpResource } from "effect/observability";
import { jsonValueSchema } from "@seqlane/core";
import type { OtlpLogger, OtlpMetrics, OtlpTracer } from "effect/observability";
import type {
  TelemetryLog,
  TelemetryMetric,
  TelemetrySpan,
} from "./collector.js";

type NativeSpan =
  OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];
type NativeLog = NonNullable<
  OtlpLogger.LogsData["resourceLogs"][number]["scopeLogs"][number]["logRecords"]
>[number];
type NativeMetric =
  OtlpMetrics.MetricsData["resourceMetrics"][number]["scopeMetrics"][number]["metrics"][number];

export interface ExportSpan extends Omit<TelemetrySpan, "links"> {
  readonly startTimeUnixNano?: string;
  readonly endTimeUnixNano?: string;
  readonly links?: ReadonlyArray<{
    readonly traceId: string;
    readonly spanId: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }>;
}

export const resource = OtlpResource.make({ serviceName: "seqlane" });
export const scope = { name: "seqlane", version: "1" };
function attributes(
  values: Readonly<Record<string, unknown>>,
  policy: "metadata" | "full",
) {
  const entries = Object.entries(values).filter(
    ([key]) =>
      policy === "full" ||
      !["seqlane.observation", "seqlane.activity", "seqlane.event"].includes(
        key,
      ),
  );
  // Canonical objects remain complete JSON strings. Native OTLP's fallback
  // formatter for arbitrary objects is for display, not exact round trips.
  return OtlpResource.entriesToAttributes(
    entries.map(([key, value]) => {
      // Native tracer attributes are unknown at this private interop boundary.
      // Reject the whole projection if an attribute is not complete JSON.
      const accepted = jsonValueSchema.parse(value);
      return [
        key,
        accepted !== null && typeof accepted === "object"
          ? JSON.stringify(accepted)
          : accepted,
      ];
    }),
  );
}

function nanoseconds(milliseconds: number): string {
  return String(
    BigInt(Math.trunc(milliseconds)) * 1_000_000n +
      BigInt(Math.trunc((milliseconds % 1) * 1_000_000)),
  );
}

export function spanPayload(
  span: ExportSpan,
  policy: "metadata" | "full",
): NativeSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 }[
      span.kind ?? "internal"
    ],
    startTimeUnixNano: span.startTimeUnixNano ?? nanoseconds(span.startTime),
    endTimeUnixNano: span.endTimeUnixNano ?? nanoseconds(span.endTime!),
    attributes: attributes(span.attributes, policy),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: (span.links ?? []).map((link) => ({
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: attributes(link.attributes ?? {}, policy),
      droppedAttributesCount: 0,
    })),
    droppedLinksCount: 0,
    status: { code: span.status === "error" ? 2 : 1 },
  };
}

export function logPayload(log: TelemetryLog): NativeLog {
  return {
    timeUnixNano: nanoseconds(Date.parse(log.timestamp)),
    observedTimeUnixNano: nanoseconds(Date.parse(log.timestamp)),
    severityText: log.severity,
    severityNumber: log.severity === "ERROR" ? 17 : 9,
    body: { stringValue: log.body },
    ...(log.traceId === undefined ? {} : { traceId: log.traceId }),
    ...(log.spanId === undefined ? {} : { spanId: log.spanId }),
    attributes: attributes(log.attributes, "metadata"),
    droppedAttributesCount: 0,
  };
}

export function metricPayload(
  metric: TelemetryMetric,
  timestamp: string,
): NativeMetric {
  const dataPoint = {
    timeUnixNano: timestamp,
    ...(Number.isSafeInteger(metric.value)
      ? { asInt: String(metric.value) }
      : { asDouble: metric.value }),
    attributes: attributes(metric.attributes, "metadata"),
  };
  if (metric.kind === "gauge") {
    return {
      name: metric.name,
      gauge: { dataPoints: [dataPoint] },
    };
  }
  return {
    name: metric.name,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [dataPoint],
    },
  };
}
