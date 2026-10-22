import { Clock, Effect, Exit, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { OtlpSerialization } from "effect/observability";
import type { TelemetryConfiguration } from "./configuration.js";
import type { TelemetryLog, TelemetryMetric } from "./collector.js";
import {
  createCanonicalMetricRegistry,
  recordTelemetryExportFailure,
  snapshotCanonicalMetrics,
} from "./canonical-metrics.js";
import { readAcknowledgement } from "./otlp-acknowledgement.js";
import {
  resource,
  scope,
  spanPayload,
  logPayload,
  metricPayload,
  type ExportSpan,
} from "./otlp-projection.js";

type Signal = "traces" | "logs" | "metrics";

function endpoint(base: string, signal: Signal): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/${signal}`;
  return url.href;
}

interface ExportBatchOptions<A, B> {
  readonly signal: Signal;
  readonly source: ReadonlyArray<A>;
  readonly project: (value: A) => B;
  readonly encode: (values: B[]) => HttpBody.HttpBody;
  readonly maxBytes: number;
  readonly send: (
    signal: Signal,
    body: HttpBody.HttpBody,
  ) => Effect.Effect<void, unknown>;
  readonly drop: () => void;
}

function encodedLength(body: HttpBody.HttpBody): number {
  if (body._tag !== "Uint8Array")
    throw new TypeError("Expected native OTLP JSON bytes");
  return body.body.byteLength;
}

function exportBatches<A, B>(options: ExportBatchOptions<A, B>) {
  return Effect.gen(function* () {
    const overhead = encodedLength(options.encode([]));
    let bytes = overhead;
    let batch: B[] = [];
    for (const value of options.source) {
      const record = yield* Effect.try(() => options.project(value));
      const recordBytes = encodedLength(options.encode([record])) - overhead;
      if (overhead + recordBytes > options.maxBytes) {
        options.drop();
        continue;
      }
      const separator = batch.length === 0 ? 0 : 1;
      if (bytes + separator + recordBytes > options.maxBytes) {
        yield* options.send(options.signal, options.encode(batch));
        batch = [];
        bytes = overhead;
      }
      bytes += (batch.length === 0 ? 0 : 1) + recordBytes;
      batch.push(record);
    }
    if (batch.length > 0)
      yield* options.send(options.signal, options.encode(batch));
  });
}

/** Native OTLP JSON serialization and scoped HTTP, with one total shutdown deadline. */
export async function exportTelemetry(
  configuration: TelemetryConfiguration,
  telemetry: {
    readonly spans: ReadonlyArray<ExportSpan>;
    readonly logs: ReadonlyArray<TelemetryLog>;
    readonly metrics: ReadonlyArray<TelemetryMetric>;
  },
  clock?: Clock.Clock,
): Promise<{
  readonly failed: boolean;
  readonly droppedRecords: number;
  readonly exportFailures: number;
}> {
  let droppedRecords = 0;
  let exportFailures = 0;
  let deadlineExpired = false;
  const exportMetricRegistry = createCanonicalMetricRegistry();
  const program = Effect.gen(function* () {
    const serializer = yield* OtlpSerialization.OtlpSerialization;
    const client = HttpClient.withScope(
      HttpClient.filterStatusOk(yield* HttpClient.HttpClient),
    );
    const start = yield* Clock.monotonicTimeNanos;
    const deadline =
      start + BigInt(configuration.shutdownTimeoutMs) * 1_000_000n;
    const checkDeadline = Effect.flatMap(Clock.monotonicTimeNanos, (now) =>
      now >= deadline
        ? Effect.fail(new Error("Telemetry shutdown deadline exceeded"))
        : Effect.void,
    );
    const send = (signal: Signal, body: HttpBody.HttpBody) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* checkDeadline;
          if (encodedLength(body) > configuration.maxPendingBytes) {
            return yield* Effect.fail(
              new Error("OTLP body exceeded its byte limit"),
            );
          }
          const request = HttpClientRequest.post(
            endpoint(configuration.endpoint, signal),
            {
              headers: configuration.headers,
            },
          ).pipe(HttpClientRequest.setBody(body));
          const response = yield* client.execute(request);
          yield* readAcknowledgement(response);
          yield* checkDeadline;
        }),
      );
    const common = {
      maxBytes: configuration.maxPendingBytes,
      send,
      drop: () => {
        droppedRecords += 1;
      },
    };
    const completedSpans = telemetry.spans.filter((span) => {
      if (span.endTime !== undefined || span.endTimeUnixNano !== undefined)
        return true;
      droppedRecords += 1;
      return false;
    });
    const exportSignal = (
      signal: Signal,
      batches: Effect.Effect<void, unknown>,
    ) =>
      Effect.gen(function* () {
        if (deadlineExpired) return;
        const deadline = yield* Effect.result(checkDeadline);
        if (deadline._tag === "Failure") {
          deadlineExpired = true;
          return;
        }
        let failureRecorded = false;
        const recordFailure = () => {
          if (failureRecorded) return;
          failureRecorded = true;
          exportFailures += 1;
          recordTelemetryExportFailure(exportMetricRegistry, signal);
        };
        yield* Effect.exit(
          Effect.onExit(batches, (exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) recordFailure();
            }),
          ),
        );
      });
    yield* exportSignal(
      "traces",
      exportBatches({
        ...common,
        signal: "traces",
        source: completedSpans,
        project: (span) => spanPayload(span, configuration.payloadPolicy),
        encode: (spans) =>
          serializer.traces({
            resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }],
          }),
      }),
    );
    yield* exportSignal(
      "logs",
      exportBatches({
        ...common,
        signal: "logs",
        source: telemetry.logs,
        project: logPayload,
        encode: (logRecords) =>
          serializer.logs({
            resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords }] }],
          }),
      }),
    );
    const timestamp = String(yield* Clock.currentTimeNanos);
    const metrics = [
      ...telemetry.metrics,
      ...snapshotCanonicalMetrics(exportMetricRegistry),
    ];
    yield* exportSignal(
      "metrics",
      exportBatches({
        ...common,
        signal: "metrics",
        source: metrics,
        project: (metric) => metricPayload(metric, timestamp),
        encode: (metrics) =>
          serializer.metrics({
            resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }],
          }),
      }),
    );
  }).pipe(
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch),
        Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    ),
    Effect.provide(OtlpSerialization.layerJson),
    Effect.timeout(`${configuration.shutdownTimeoutMs} millis`),
  );
  const result = await Effect.runPromise(
    Effect.exit(
      clock === undefined
        ? program
        : Effect.provideService(program, Clock.Clock, clock),
    ),
  );
  return {
    failed: Exit.isFailure(result) || deadlineExpired || exportFailures > 0,
    droppedRecords,
    exportFailures,
  };
}
