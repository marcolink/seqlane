import { describe, expect, it } from "vitest";
import {
  decodeSeqlaneExecutionEvent,
  encodeSeqlaneExecutionEvent,
  isSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
  type SeqlaneExecutionEventConsumer,
} from "./index.js";

const metadata = {
  schemaVersion: 1 as const,
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-08-22T12:00:00.000Z",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
};

const started: SeqlaneExecutionEvent = {
  type: "run.started",
  metadata,
  workId: "work-1",
  runId: "run-1",
};

describe("@seqlane/events", () => {
  it("round-trips a canonical event with metadata", () => {
    const encoded = encodeSeqlaneExecutionEvent(started);

    expect(decodeSeqlaneExecutionEvent(encoded)).toEqual(started);
    expect(isSeqlaneExecutionEvent(JSON.parse(encoded))).toBe(true);
  });

  it("round-trips effective model selection metrics without provider payloads", () => {
    const event: SeqlaneExecutionEvent = {
      type: "invocation.output",
      metadata,
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      policy: "persistent",
      channel: "task",
      content: "Task completed",
      metrics: {
        modelSelection: {
          model: { provider: "openai", model: "gpt-5.2" },
          reasoning: "high",
        },
      },
    };

    const decoded = decodeSeqlaneExecutionEvent(
      encodeSeqlaneExecutionEvent(event),
    );

    expect(decoded).toEqual(event);
    expect(decoded).not.toHaveProperty("metrics.modelSelection.nativePayload");
  });

  it("accepts a redacted nested Plan snapshot", () => {
    const event: SeqlaneExecutionEvent = {
      type: "run.plan",
      metadata,
      workId: "work-1",
      runId: "run-1",
      plan: {
        workflow: { id: "workflow", version: "1" },
        nodes: [
          {
            planNodeId: "repeat:1",
            type: "repeat",
            label: "repeat items",
            dependsOn: [],
            siblingOrder: 0,
            maximumIterations: 3,
          },
          {
            planNodeId: "repeat:1/body/task:1",
            type: "task",
            label: "process item",
            taskId: "process-item",
            dependsOn: [],
            parentPlanNodeId: "repeat:1",
            siblingOrder: 0,
          },
        ],
      },
    };

    expect(
      decodeSeqlaneExecutionEvent(encodeSeqlaneExecutionEvent(event)),
    ).toEqual(event);
  });

  it("accepts executor-neutral task session policies in a Plan snapshot", () => {
    const event = {
      type: "run.plan",
      metadata,
      workId: "work-1",
      runId: "run-1",
      plan: {
        workflow: { id: "workflow" },
        nodes: [
          {
            planNodeId: "prepare:1",
            type: "task",
            label: "prepare",
            dependsOn: [],
            siblingOrder: 0,
            session: { type: "isolated" },
          },
          {
            planNodeId: "review:1",
            type: "task",
            label: "review",
            dependsOn: ["prepare:1"],
            siblingOrder: 1,
            session: { type: "branch", from: "prepare:1" },
          },
        ],
      },
    };

    expect(isSeqlaneExecutionEvent(event)).toBe(true);
    expect(
      isSeqlaneExecutionEvent({
        ...event,
        plan: {
          ...event.plan,
          nodes: [
            ...event.plan.nodes,
            {
              planNodeId: "invalid:1",
              type: "validation.gate",
              label: "invalid",
              dependsOn: [],
              siblingOrder: 2,
              session: { type: "isolated" },
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("rejects missing or invalid metadata and unknown fields", () => {
    expect(isSeqlaneExecutionEvent({ ...started, metadata: undefined })).toBe(
      false,
    );
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: { ...metadata, sequence: -1 },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: { ...metadata, occurredAt: "2026-08-22" },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: {
          ...metadata,
          traceparent:
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        },
      }),
    ).toBe(false);
    expect(isSeqlaneExecutionEvent({ ...started, extra: true })).toBe(false);
    expect(() =>
      decodeSeqlaneExecutionEvent(JSON.stringify(started)),
    ).not.toThrow();
  });

  it("normalizes malformed serialized events at the decode boundary", () => {
    expect(() => decodeSeqlaneExecutionEvent("not-json")).toThrow(
      "Invalid Seqlane execution event",
    );
    expect(() => decodeSeqlaneExecutionEvent(JSON.stringify({}))).toThrow(
      "Invalid Seqlane execution event",
    );
  });

  it("rejects malformed static Plan topology", () => {
    const planEvent: SeqlaneExecutionEvent = {
      type: "run.plan",
      metadata,
      workId: "work-1",
      runId: "run-1",
      plan: {
        workflow: { id: "workflow" },
        nodes: [
          {
            planNodeId: "task:1",
            type: "task",
            label: "task",
            dependsOn: [],
            siblingOrder: 0,
          },
        ],
      },
    };

    expect(
      isSeqlaneExecutionEvent({
        ...planEvent,
        plan: {
          ...planEvent.plan,
          nodes: [...planEvent.plan.nodes, planEvent.plan.nodes[0]],
        },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...planEvent,
        plan: {
          ...planEvent.plan,
          nodes: [
            {
              ...planEvent.plan.nodes[0],
              dependsOn: ["missing:node"],
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...planEvent,
        plan: {
          ...planEvent.plan,
          nodes: [
            {
              ...planEvent.plan.nodes[0],
              parentPlanNodeId: "missing:parent",
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("defines a consumer contract with ordered event delivery", async () => {
    const received: SeqlaneExecutionEvent[] = [];
    const consumer: SeqlaneExecutionEventConsumer = {
      consume(event) {
        received.push(event);
      },
      async flush() {
        await Promise.resolve();
      },
      async close() {
        await Promise.resolve();
      },
    };

    consumer.consume(started);
    await consumer.flush();
    await consumer.close();

    expect(received).toEqual([started]);
  });
});
