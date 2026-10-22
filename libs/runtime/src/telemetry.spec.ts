// @test-scope ./private/telemetry/run-scope.ts
import { describe, expect, it } from "vitest";
import { Effect, Tracer } from "effect";
import {
  createNativeSpanCollector,
  runCliWithTelemetry,
} from "./private/telemetry/run-scope.js";

describe("run-scoped telemetry", () => {
  it("creates a real CLI span and derives a valid worker carrier", async () => {
    let carrier: string | undefined;
    const run = await runCliWithTelemetry(async (context) => {
      carrier = context.traceparent;
      return "complete";
    });

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
