// @test-scope ./collector.ts
// @test-scope ./native-observation-projection.ts
import { describe, expect, it } from "vitest";
import { seqlaneExecutionEventSchema } from "@seqlane/protocol";
import { createInProcessTelemetry } from "./collector.js";

const carrier = {
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};

describe("bounded canonical telemetry collector", () => {
  it("retains whole observation values and source timing under the real trace parent", () => {
    const telemetry = createInProcessTelemetry();
    const observation = seqlaneExecutionEventSchema.parse({
      type: "invocation.observation",
      metadata: {
        schemaVersion: 1,
        eventId: "2",
        sequence: 1,
        occurredAt: "2026-10-21T10:00:02.000Z",
        ...carrier,
      },
      workId: "work",
      runId: "run",
      invocationId: "invocation",
      observationId: "exchange",
      kind: "model",
      state: "succeeded",
      attemptIndex: 2,
      model: {
        operation: "model.generate",
        request: {
          prompt: "whole request",
          count: 0,
          enabled: false,
          empty: "",
        },
        response: { text: "whole response", value: null },
        usage: { inputTokens: 0 },
        startedAt: Date.parse("2026-10-21T10:00:01.000Z"),
        endedAt: Date.parse("2026-10-21T10:00:02.000Z"),
      },
    });
    telemetry.record(observation);
    const result = telemetry.snapshot();
    expect(result.events[0]).toEqual(observation);
    expect(result.spans).toHaveLength(1);
    const observationSpan = result.spans.find(
      (span) => span.name === "model.generate",
    );
    expect(observationSpan).toMatchObject({
      traceId: "0123456789abcdef0123456789abcdef",
      parentSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      startTime: Date.parse("2026-10-21T10:00:01.000Z"),
      endTime: Date.parse("2026-10-21T10:00:02.000Z"),
      attributes: {
        "seqlane.observation": observation,
        "seqlane.attempt.index": 2,
      },
    });
    expect(observationSpan?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(observationSpan?.spanId).not.toBe("0123456789abcdef");
    expect(
      result.logs.every(
        (log) => log.traceId === "0123456789abcdef0123456789abcdef",
      ),
    ).toBe(true);
  });

  it("excludes ACP cumulative session usage from model-exchange counters", () => {
    const telemetry = createInProcessTelemetry();
    telemetry.record(
      seqlaneExecutionEventSchema.parse({
        type: "invocation.observation",
        metadata: {
          schemaVersion: 1,
          eventId: "1",
          sequence: 1,
          occurredAt: "2026-10-21T10:00:00.000Z",
          ...carrier,
        },
        workId: "work",
        runId: "run",
        invocationId: "invocation",
        observationId: "usage",
        kind: "model",
        state: "succeeded",
        model: {
          operation: "acp.session.usage",
          usage: { inputTokens: 12 },
          cost: 0,
        },
      }),
    );
    const metrics = telemetry.snapshot().metrics;
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      name: "seqlane.event.payload_bytes",
      value: expect.any(Number),
    });
    expect(
      metrics.some((metric) => metric.name.startsWith("seqlane.model.")),
    ).toBe(false);
  });

  it("parents observations beneath the matching native adapter span", () => {
    const telemetry = createInProcessTelemetry();
    telemetry.recordSpan({
      name: "seqlane.invocation",
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "1111111111111111",
      startTimeUnixNano: "1792576800000000000",
      endTimeUnixNano: "1792576810000000000",
      kind: "internal",
      status: "ok",
      links: [],
      attributes: { "seqlane.invocation.id": "invocation-1" },
    });
    telemetry.recordSpan({
      name: "seqlane.adapter.execute",
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "2222222222222222",
      parentSpanId: "1111111111111111",
      startTimeUnixNano: "1792576801000000000",
      endTimeUnixNano: "1792576809000000000",
      kind: "client",
      status: "ok",
      links: [],
      attributes: { "seqlane.invocation.id": "invocation-1" },
    });
    telemetry.record(
      seqlaneExecutionEventSchema.parse({
        type: "invocation.observation",
        metadata: {
          schemaVersion: 1,
          eventId: "1",
          sequence: 1,
          occurredAt: "2026-10-21T10:00:02.000Z",
          ...carrier,
        },
        workId: "work",
        runId: "run",
        invocationId: "invocation-1",
        observationId: "exchange-1",
        kind: "model",
        state: "succeeded",
        model: {
          operation: "model.generate",
          request: { prompt: "request" },
          response: { text: "response" },
          startedAt: Date.parse("2026-10-21T10:00:01.000Z"),
          endedAt: Date.parse("2026-10-21T10:00:02.000Z"),
        },
      }),
    );
    const observation = telemetry
      .snapshot()
      .spans.find((span) => span.name === "model.generate");
    expect(observation?.parentSpanId).toBe("2222222222222222");
  });

  it("evicts complete oldest records at the byte limit", () => {
    const telemetry = createInProcessTelemetry({
      maxBytes: 1_000,
      maxRecords: 4,
    });
    const makeEvent = (eventId: string, sequence: number) =>
      seqlaneExecutionEventSchema.parse({
        type: "run.heartbeat",
        metadata: {
          schemaVersion: 1,
          eventId,
          sequence,
          occurredAt: "2026-10-21T10:00:00.000Z",
          ...carrier,
        },
        workId: "w".repeat(400),
        runId: "run",
        activeInvocationIds: [],
        elapsedMs: 0,
      });
    const first = makeEvent("first", 1);
    const second = makeEvent("second", 2);
    telemetry.record(first);
    telemetry.record(second);
    const snapshot = telemetry.snapshot();
    expect(snapshot.events).toEqual([second]);
    expect(snapshot.droppedRecords).toBe(1);
    expect(snapshot.retainedBytes).toBeGreaterThan(0);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(1_000);
  });
});
