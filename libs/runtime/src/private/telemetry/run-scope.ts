import {
  Effect,
  Exit,
  Logger,
  Metric,
  Option,
  References,
  Tracer,
} from "effect";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import {
  telemetrySpanSnapshotSchema,
  type TelemetrySpanSnapshot,
} from "@seqlane/protocol/private/telemetry-span-snapshot";
import {
  createInProcessTelemetry,
  type InProcessTelemetry,
} from "./collector.js";

export interface CapturedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTime: bigint;
  readonly endTime?: bigint;
  readonly status: "started" | "ended";
  readonly kind: Tracer.SpanKind;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly links: ReadonlyArray<{
    readonly traceId: string;
    readonly spanId: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
}

const MAX_CAPTURED_SPANS = 1_000;
const MAX_CAPTURED_SPAN_BYTES = 3 * 1024 * 1024;

export function createNativeSpanCollector(): {
  readonly tracer: Tracer.Tracer;
  readonly snapshot: () => {
    readonly spans: ReadonlyArray<TelemetrySpanSnapshot>;
    readonly droppedRecords: number;
  };
} {
  const spans: Array<Tracer.NativeSpan> = [];
  const reportedDrops = new WeakSet<Tracer.NativeSpan>();
  let droppedRecords = 0;
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      if (spans.length < MAX_CAPTURED_SPANS) spans.push(span);
      else droppedRecords += 1;
      return span;
    },
  });
  return {
    tracer,
    snapshot() {
      const snapshots: TelemetrySpanSnapshot[] = [];
      let retainedBytes = 0;
      for (const span of spans) {
        if (span.status._tag !== "Ended") continue;
        const parent = Option.getOrUndefined(span.parent);
        const attributes = Object.fromEntries(span.attributes);
        const outcome = attributes["seqlane.outcome"];
        const candidate = {
          name: span.name,
          traceId: span.traceId,
          spanId: span.spanId,
          ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
          startTimeUnixNano: String(span.startTime),
          endTimeUnixNano: String(span.status.endTime),
          kind: span.kind,
          status:
            outcome === "failed" ||
            (Exit.isFailure(span.status.exit) && outcome !== "cancelled")
              ? "error"
              : "ok",
          links: span.links.map((link) => ({
            traceId: link.span.traceId,
            spanId: link.span.spanId,
            ...(Object.keys(link.attributes).length === 0
              ? {}
              : { attributes: link.attributes }),
          })),
          attributes,
        };
        const parsed = telemetrySpanSnapshotSchema.safeParse(candidate);
        const bytes = parsed.success
          ? Buffer.byteLength(JSON.stringify(parsed.data), "utf8")
          : 0;
        if (
          parsed.success &&
          retainedBytes + bytes <= MAX_CAPTURED_SPAN_BYTES
        ) {
          snapshots.push(parsed.data);
          retainedBytes += bytes;
        } else {
          if (!reportedDrops.has(span)) {
            reportedDrops.add(span);
            droppedRecords += 1;
          }
        }
      }
      return { spans: snapshots, droppedRecords };
    },
  };
}

function createCollector(spans: Array<Tracer.NativeSpan>): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      if (spans.length < MAX_CAPTURED_SPANS) spans.push(span);
      return span;
    },
  });
}

function boundedLogger(
  collector: InProcessTelemetry,
): Logger.Logger<unknown, void> {
  return Logger.make((options) => {
    const message =
      typeof options.message === "string"
        ? options.message
        : Array.isArray(options.message)
          ? options.message
              .filter((part): part is string => typeof part === "string")
              .join(" ")
          : "structured runtime log";
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    const stringValue = (key: string): string | undefined => {
      const value = annotations[key];
      return typeof value === "string" ? value : undefined;
    };
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(annotations)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        attributes[key] = value;
      }
    }
    const severity =
      options.logLevel === "Error" || options.logLevel === "Fatal"
        ? "ERROR"
        : "INFO";
    collector.recordLog({
      timestamp: options.date.toISOString(),
      severity,
      body: message.slice(0, 512),
      ...(stringValue("trace_id") === undefined
        ? {}
        : { traceId: stringValue("trace_id") }),
      ...(stringValue("span_id") === undefined
        ? {}
        : { spanId: stringValue("span_id") }),
      attributes,
    });
  });
}

function capturedSpan(span: Tracer.NativeSpan): CapturedSpan {
  const parent = Option.getOrUndefined(span.parent);
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
    startTime: span.startTime,
    ...(span.status._tag === "Ended" ? { endTime: span.status.endTime } : {}),
    status: span.status._tag === "Ended" ? "ended" : "started",
    kind: span.kind,
    attributes: Object.fromEntries(span.attributes),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: link.attributes,
    })),
  };
}

function carrierFor(span: Tracer.AnySpan): TraceCarrier {
  return {
    traceparent: `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`,
  };
}

/** Builds the private propagation carrier from the active native span. */
export const currentTraceCarrier: Effect.Effect<TraceCarrier> =
  Effect.currentParentSpan.pipe(Effect.map(carrierFor), Effect.orDie);

export interface CliTelemetryContext {
  readonly carrier: TraceCarrier;
  readonly collector: InProcessTelemetry;
}

export interface CliTelemetryRun<A> extends CliTelemetryContext {
  readonly value: A;
  snapshot(): {
    readonly spans: ReadonlyArray<CapturedSpan>;
    readonly telemetry: ReturnType<InProcessTelemetry["snapshot"]>;
  };
}

/** Composes a CLI Effect beneath its local telemetry parent span. */
export function withCliTelemetryEffect<A, E, R>(
  operation: (context: CliTelemetryContext) => Effect.Effect<A, E, R>,
): Effect.Effect<CliTelemetryRun<A>, E, R> {
  return Effect.suspend(() => {
    const spans: Array<Tracer.NativeSpan> = [];
    const collector = createInProcessTelemetry();
    const tracer = createCollector(spans);
    const logger = boundedLogger(collector);
    const metricRegistry = new Map();
    return Effect.gen(function* () {
      const parent = yield* Effect.currentParentSpan.pipe(Effect.orDie);
      const carrier = carrierFor(parent);
      yield* Effect.log("seqlane.cli.run.started").pipe(
        Effect.annotateLogs({
          trace_id: parent.traceId,
          span_id: parent.spanId,
        }),
      );
      const value = yield* operation({ carrier, collector });
      return {
        value,
        carrier,
        collector,
        snapshot: () => ({
          spans: spans.map(capturedSpan),
          telemetry: collector.snapshot(),
        }),
      };
    }).pipe(
      Effect.withSpan("seqlane.cli.run", { kind: "internal" }),
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, metricRegistry),
    );
  });
}

/** Starts a worker span beneath the validated CLI parent carrier. */
export function withWorkerRunSpan<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  carrier?: TraceCarrier,
): Effect.Effect<A, E, R> {
  const parent = carrier === undefined ? undefined : externalParent(carrier);
  return Effect.withSpan(effect, "seqlane.worker.run", {
    ...(parent === undefined ? {} : { parent }),
    kind: "internal",
  });
}

/** Re-establishes the active worker parent at a documented nested runtime boundary. */
export function withRuntimeExecutionSpan<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  carrier?: TraceCarrier,
): Effect.Effect<A, E, R> {
  const parent = carrier === undefined ? undefined : externalParent(carrier);
  return Effect.withSpan(effect, "seqlane.runtime.execution", {
    ...(parent === undefined ? {} : { parent }),
    kind: "internal",
  });
}

function externalParent(carrier: TraceCarrier): Tracer.ExternalSpan {
  const [, traceId, spanId, flags] = carrier.traceparent.split("-");
  return Tracer.externalSpan({
    traceId: traceId!,
    spanId: spanId!,
    sampled: Number.parseInt(flags!, 16) % 2 === 1,
  });
}
