// @test-scope ./serialized-events.ts

import { describe, expect, expectTypeOf, it } from "vitest";
import type { SeqlaneExecutionEvent } from "./serialized-events.js";
import {
  decodeSeqlaneExecutionEvent,
  encodeSeqlaneExecutionEvent,
} from "./serialized-events-serialization.js";
import {
  isSeqlaneExecutionEvent,
  seqlaneExecutionEventSchema,
  type ReadonlySchemaOutput,
} from "./serialized-events.js";
import { isJsonValue } from "./json.js";

const metadata = {
  schemaVersion: 1 as const,
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-08-22T12:00:00.000Z",
};

const started: SeqlaneExecutionEvent = {
  type: "run.started",
  metadata,
  workId: "work-1",
  runId: "run-1",
};

describe("core serialized execution events", () => {
  it("derives the public event type from its canonical schema", () => {
    expectTypeOf<SeqlaneExecutionEvent>().toEqualTypeOf<
      ReadonlySchemaOutput<typeof seqlaneExecutionEventSchema>
    >();
  });

  it("round-trips valid events and rejects malformed JSON", () => {
    const encoded = encodeSeqlaneExecutionEvent(started);
    expect(decodeSeqlaneExecutionEvent(encoded)).toEqual(started);
    expect(() => decodeSeqlaneExecutionEvent("not-json")).toThrow(
      "Invalid Seqlane execution event",
    );
    expect(() => decodeSeqlaneExecutionEvent(JSON.stringify({}))).toThrow(
      "Invalid Seqlane execution event",
    );
  });

  it("rejects unknown fields, invalid metadata, and unsafe plan topology", () => {
    expect(isSeqlaneExecutionEvent({ ...started, extra: true })).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: { ...metadata, traceparent: undefined },
      }),
    ).toBe(false);

    const planEvent = {
      type: "run.plan" as const,
      metadata,
      workId: "work-1",
      runId: "run-1",
      plan: {
        workflow: { id: "workflow-1" },
        nodes: [
          {
            planNodeId: "task-1",
            type: "task" as const,
            label: "Task",
            dependsOn: [] as string[],
            siblingOrder: 0,
          },
        ],
      },
    };
    expect(isSeqlaneExecutionEvent(planEvent)).toBe(true);
    expect(
      isSeqlaneExecutionEvent({
        ...planEvent,
        plan: {
          ...planEvent.plan,
          nodes: [{ ...planEvent.plan.nodes[0], dependsOn: ["missing"] }],
        },
      }),
    ).toBe(false);
  });

  it("accepts finite acyclic JSON and rejects cyclic values", () => {
    expect(isJsonValue({ nested: [null, true, 2, "value"] })).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(isJsonValue(cycle)).toBe(false);
  });
});
