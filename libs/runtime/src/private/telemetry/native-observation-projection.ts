import { Context, Exit, Option, Tracer } from "effect";
import type {
  InvocationObservationEvent,
  SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import type { TelemetrySpanSnapshot } from "@seqlane/protocol/private/telemetry-span-snapshot";
import type { TelemetrySpan } from "./collector.js";

export interface NativeObservationProjection {
  readonly span: Tracer.NativeSpan;
  readonly status: TelemetrySpan["status"];
  readonly sourceStartTime: number;
  readonly sourceEndTime?: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly sourceEvent:
    | InvocationObservationEvent
    | Extract<SeqlaneExecutionEvent, { type: "invocation.activity" }>;
}

function nativeProjection(
  event:
    | InvocationObservationEvent
    | Extract<SeqlaneExecutionEvent, { type: "invocation.activity" }>,
  parent?: Tracer.AnySpan,
  sourceStartTime?: number,
): NativeObservationProjection {
  const isObservation = event.type === "invocation.observation";
  const start = isObservation
    ? (event.model.startedAt ??
      sourceStartTime ??
      Date.parse(event.metadata.occurredAt))
    : (event.startedAt ??
      sourceStartTime ??
      Date.parse(event.metadata.occurredAt));
  const sourceEnd = isObservation ? event.model.endedAt : event.endedAt;
  const terminal = isObservation
    ? event.state === "succeeded" ||
      event.state === "failed" ||
      event.state === "cancelled"
    : event.state === "succeeded" || event.state === "failed";
  const failed = event.state === "failed";
  const status: TelemetrySpan["status"] = failed
    ? "error"
    : terminal
      ? "ended"
      : "started";
  const native = new Tracer.NativeSpan({
    name: isObservation
      ? (event.model.operation ?? "model.exchange")
      : `${event.kind}.${event.name}`,
    parent: Option.fromNullishOr(parent),
    annotations: Context.empty(),
    links: [],
    startTime: BigInt(Math.round(start * 1_000_000)),
    kind: isObservation ? "client" : "internal",
    sampled: true,
  });
  const attributes = isObservation
    ? {
        "seqlane.invocation.id": event.invocationId,
        ...(event.attemptIndex === undefined
          ? {}
          : { "seqlane.attempt.index": event.attemptIndex }),
        ...(event.iteration === undefined
          ? {}
          : { "seqlane.iteration": event.iteration }),
        "seqlane.observation.id": event.observationId,
        ...(event.parentObservationId === undefined
          ? {}
          : { "seqlane.observation.parent_id": event.parentObservationId }),
        "seqlane.observation": event,
      }
    : {
        "seqlane.invocation.id": event.invocationId,
        "seqlane.activity.id": event.activityId,
        "seqlane.activity.kind": event.kind,
        ...(event.iteration === undefined
          ? {}
          : { "seqlane.iteration": event.iteration }),
        "seqlane.activity": event,
      };
  for (const [key, value] of Object.entries(attributes))
    native.attribute(key, value);
  if (terminal) {
    const endTime = sourceEnd ?? Date.parse(event.metadata.occurredAt);
    native.end(
      BigInt(Math.round(endTime * 1_000_000)),
      failed
        ? Exit.fail(new Error("Source observation failed"))
        : Exit.succeed(undefined),
    );
  }
  return {
    span: native,
    status,
    sourceStartTime: start,
    ...(sourceEnd === undefined ? {} : { sourceEndTime: sourceEnd }),
    attributes,
    sourceEvent: event,
  };
}

export function projectNativeObservationSpans(
  events: ReadonlyArray<SeqlaneExecutionEvent>,
  previous: ReadonlyMap<string, NativeObservationProjection>,
  capturedSpans: ReadonlyArray<TelemetrySpanSnapshot>,
): {
  readonly spans: ReadonlyArray<TelemetrySpan>;
  readonly projections: Map<string, NativeObservationProjection>;
} {
  const latestByKey = new Map<string, SeqlaneExecutionEvent>();
  const starts = new Map<string, number>();
  for (const event of events) {
    const key =
      event.type === "invocation.observation"
        ? `model:${event.observationId}`
        : event.type === "invocation.activity"
          ? `activity:${event.activityId}`
          : undefined;
    if (key === undefined) continue;
    latestByKey.set(key, event);
    starts.set(key, starts.get(key) ?? Date.parse(event.metadata.occurredAt));
  }
  const invocationParents = new Map<string, TelemetrySpanSnapshot>();
  const adapterParents = new Map<string, TelemetrySpanSnapshot>();
  for (const span of capturedSpans) {
    const invocationId = span.attributes["seqlane.invocation.id"];
    if (typeof invocationId !== "string") continue;
    if (span.name === "seqlane.invocation")
      invocationParents.set(invocationId, span);
    if (span.name === "seqlane.adapter.execute")
      adapterParents.set(invocationId, span);
  }
  const externalSpan = (
    span: TelemetrySpanSnapshot | undefined,
  ): Tracer.ExternalSpan | undefined =>
    span === undefined
      ? undefined
      : Tracer.externalSpan({
          traceId: span.traceId,
          spanId: span.spanId,
          sampled: true,
        });
  const projected = new Map<string, NativeObservationProjection>();
  for (const [key, event] of latestByKey) {
    if (
      event.type !== "invocation.observation" &&
      event.type !== "invocation.activity"
    )
      continue;
    const prior = previous.get(key);
    if (prior?.sourceEvent === event) {
      projected.set(key, prior);
      continue;
    }
    const parentKey =
      event.type === "invocation.observation" &&
      event.parentObservationId !== undefined
        ? `model:${event.parentObservationId}`
        : undefined;
    const parent =
      parentKey === undefined ? undefined : projected.get(parentKey)?.span;
    const actualParent = externalSpan(
      adapterParents.get(event.invocationId) ??
        invocationParents.get(event.invocationId),
    );
    const [, traceId, parentSpanId] =
      event.metadata.traceparent?.split("-") ?? [];
    const carrierParent =
      traceId !== undefined && parentSpanId !== undefined
        ? Tracer.externalSpan({ traceId, spanId: parentSpanId })
        : undefined;
    const next = nativeProjection(
      event,
      parent ?? actualParent ?? carrierParent,
      prior?.sourceStartTime ?? starts.get(key),
    );
    if (prior !== undefined) {
      for (const [attribute, value] of Object.entries(next.attributes))
        prior.span.attribute(attribute, value);
      if (next.span.status._tag === "Ended") {
        prior.span.end(next.span.status.endTime, next.span.status.exit);
      }
      projected.set(key, { ...next, span: prior.span });
    } else {
      projected.set(key, next);
    }
  }
  const spans = [...projected.values()].map(
    ({ span, status, sourceStartTime, sourceEndTime, attributes }) => {
      const parent = Option.getOrUndefined(span.parent);
      const ended =
        span.status._tag === "Ended" ? span.status.endTime : undefined;
      const endTime =
        sourceEndTime ??
        (ended === undefined ? undefined : Number(ended) / 1_000_000);
      return {
        name: span.name,
        traceId: span.traceId,
        spanId: span.spanId,
        ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
        startTime: sourceStartTime,
        ...(endTime === undefined ? {} : { endTime }),
        status,
        attributes,
        startTimeUnixNano: String(span.startTime),
        ...(ended === undefined ? {} : { endTimeUnixNano: String(ended) }),
        kind: span.kind,
        links: span.links.map((link) => ({
          traceId: link.span.traceId,
          spanId: link.span.spanId,
          ...(Object.keys(link.attributes).length === 0
            ? {}
            : { attributes: link.attributes }),
        })),
      };
    },
  );
  return { spans, projections: projected };
}
