// @test-scope ./private/telemetry/run-scope.ts
import { describe, expect, it } from "vitest";
import { Effect, Metric, Tracer } from "effect";
import {
  createNativeSpanCollector,
  withCliTelemetryEffect,
} from "./private/telemetry/run-scope.js";

describe("run-scoped telemetry", () => {
  it("creates a real CLI span and derives a valid worker carrier", async () => {
    let carrier: string | undefined;
    const captured = await Effect.runPromise(
      withCliTelemetryEffect(({ carrier: context }) =>
        Effect.sync(() => {
          carrier = context.traceparent;
          return "complete";
        }),
      ),
    );
    const run = { value: captured.value, ...captured.snapshot() };

    expect(run.value).toBe("complete");
    expect(run.spans).toHaveLength(1);
    expect(run.spans[0]).toMatchObject({
      name: "seqlane.cli.run",
      status: "ended",
    });
    expect(run.telemetry.logs[0]).toMatchObject({
      body: "seqlane.cli.run.started",
      traceId: run.spans[0]?.traceId,
      spanId: run.spans[0]?.spanId,
    });
    expect(carrier).toBe(
      `00-${run.spans[0]?.traceId}-${run.spans[0]?.spanId}-01`,
    );
  });

  it("isolates collectors and metric state when the same telemetry Effect runs twice", async () => {
    let attempt = 0;
    const program = withCliTelemetryEffect(() =>
      Effect.gen(function* () {
        attempt += 1;
        yield* Effect.log(`attempt-${attempt}`);
        yield* Effect.withSpan(Effect.void, `operation-${attempt}`);
        const counter = Metric.counter("telemetry.rerun");
        yield* Metric.update(counter, 1);
        return (yield* Metric.value(counter)).count;
      }),
    );
    const first = await Effect.runPromise(program);
    const firstSnapshot = first.snapshot();
    const second = await Effect.runPromise(program);
    expect(first.collector).not.toBe(second.collector);
    expect(first.value).toBe(1);
    expect(second.value).toBe(1);
    expect(first.snapshot()).toEqual(firstSnapshot);
    expect(firstSnapshot.spans.map(({ name }) => name)).toEqual([
      "seqlane.cli.run",
      "operation-1",
    ]);
    expect(second.snapshot().spans.map(({ name }) => name)).toEqual([
      "seqlane.cli.run",
      "operation-2",
    ]);
    expect(second.snapshot().telemetry.logs.map(({ body }) => body)).toEqual([
      "seqlane.cli.run.started",
      "attempt-2",
    ]);
  });

  it("captures native nested spans with real IDs and parents", async () => {
    const collector = createNativeSpanCollector();
    const program = Effect.withSpan(
      Effect.withSpan(Effect.void, "seqlane.invocation", {
        attributes: { "seqlane.invocation.id": "invocation-1" },
      }),
      "seqlane.runtime.execution",
    ).pipe(Effect.provideService(Tracer.Tracer, collector.tracer));
    await Effect.runPromise(program);
    const snapshot = collector.snapshot();
    const runtime = snapshot.spans.find(
      (span) => span.name === "seqlane.runtime.execution",
    );
    const invocation = snapshot.spans.find(
      (span) => span.name === "seqlane.invocation",
    );
    expect(snapshot.droppedRecords).toBe(0);
    expect(runtime?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(invocation?.parentSpanId).toBe(runtime?.spanId);
    expect(invocation?.attributes["seqlane.invocation.id"]).toBe(
      "invocation-1",
    );
    expect(BigInt(invocation!.endTimeUnixNano)).toBeGreaterThanOrEqual(
      BigInt(invocation!.startTimeUnixNano),
    );
  });
});
