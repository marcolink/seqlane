import { describe, expect, it } from "vitest";
import {
  decodeTelemetrySpanSnapshotFrame,
  encodeTelemetrySpanSnapshotFrame,
  type TelemetrySpanSnapshot,
} from "./telemetry-span-snapshot.js";

describe("private telemetry span snapshots", () => {
  it("round-trips native IDs, source times, links and JSON attributes", () => {
    const frame = {
      type: "runner.telemetry.spans" as const,
      droppedRecords: 0,
      spans: [
        {
          name: "seqlane.invocation",
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "0123456789abcdef",
          parentSpanId: "fedcba9876543210",
          startTimeUnixNano: "1792576800000000000",
          endTimeUnixNano: "1792576801000000000",
          kind: "internal" as const,
          status: "ok" as const,
          links: [
            {
              traceId: "11111111111111111111111111111111",
              spanId: "2222222222222222",
            },
          ],
          attributes: {
            "seqlane.invocation.id": "invocation",
            enabled: false,
            retries: 0,
          },
        },
      ],
    };
    expect(
      decodeTelemetrySpanSnapshotFrame(encodeTelemetrySpanSnapshotFrame(frame)),
    ).toEqual(frame);
  });

  it("rejects malformed identities and oversized frames", () => {
    expect(() =>
      decodeTelemetrySpanSnapshotFrame(
        JSON.stringify({
          type: "runner.telemetry.spans",
          droppedRecords: 0,
          spans: [{ name: "invalid", traceId: "trace", spanId: "span" }],
        }),
      ),
    ).toThrow();
    const oversized = {
      type: "runner.telemetry.spans",
      droppedRecords: 0,
      spans: Array.from(
        { length: 2_000 },
        (_, index): TelemetrySpanSnapshot => ({
          name: "seqlane.invocation",
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: (index + 1).toString(16).padStart(16, "0"),
          startTimeUnixNano: "1",
          endTimeUnixNano: "2",
          kind: "internal",
          status: "ok",
          links: [],
          attributes: { detail: "x".repeat(3_000) },
        }),
      ),
    } as const;
    expect(() => encodeTelemetrySpanSnapshotFrame(oversized)).toThrow(
      /byte limit/,
    );
  });

  it("rejects zero trace identities and retains an untruncated drop count", () => {
    expect(() =>
      encodeTelemetrySpanSnapshotFrame({
        type: "runner.telemetry.spans",
        droppedRecords: 0,
        spans: [
          {
            name: "invalid",
            traceId: "0".repeat(32),
            spanId: "0123456789abcdef",
            startTimeUnixNano: "1",
            endTimeUnixNano: "2",
            kind: "internal",
            status: "ok",
            links: [],
            attributes: {},
          },
        ],
      }),
    ).toThrow();
    expect(
      encodeTelemetrySpanSnapshotFrame({
        type: "runner.telemetry.spans",
        droppedRecords: 2_001,
        spans: [],
      }),
    ).toContain('"droppedRecords":2001');
  });

  it("accepts bounded queue pressure and rejects extra or impossible values", () => {
    const frame = {
      type: "runner.telemetry.spans" as const,
      droppedRecords: 0,
      spans: [],
      queuePressure: {
        maxPendingBytes: 100,
        pendingBytesPeak: 80,
        capacityWaitsTotal: 2,
        overflowsTotal: 1,
      },
    };
    expect(
      decodeTelemetrySpanSnapshotFrame(encodeTelemetrySpanSnapshotFrame(frame)),
    ).toEqual(frame);
    expect(() =>
      decodeTelemetrySpanSnapshotFrame(
        JSON.stringify({
          ...frame,
          queuePressure: { ...frame.queuePressure, runId: "high-cardinality" },
        }),
      ),
    ).toThrow();
    expect(() =>
      encodeTelemetrySpanSnapshotFrame({
        ...frame,
        queuePressure: { ...frame.queuePressure, pendingBytesPeak: 101 },
      }),
    ).toThrow();
  });
});
