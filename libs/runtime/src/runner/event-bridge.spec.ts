import {
  ExecutorError,
  ValidationFailedError,
  type SeqlaneEvent,
} from "@seqlane/core";
import type {
  SeqlaneExecutionEvent,
  SeqlanePlanSnapshot,
} from "@seqlane/protocol";
import { describe, expect, it } from "vitest";
import { createExecutionEventBridge } from "./event-bridge.js";

const metadata = {
  schemaVersion: 1 as const,
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-08-18T00:00:00.000Z",
};

describe("execution event bridge", () => {
  it("projects events into canonical events with required metadata", async () => {
    const events: SeqlaneExecutionEvent[] = [];
    const bridge = createExecutionEventBridge(
      async (event) => {
        events.push(event);
      },
      {
        createEventId: (() => {
          let next = 0;
          return () => `event-${++next}`;
        })(),
        clock: () => new Date(metadata.occurredAt),
      },
    );
    const failure = new ExecutorError("task", new Error("private cause"));

    const seqlaneEvents: readonly SeqlaneEvent[] = [
      { type: "run.started", workId: "work-1", runId: "run-1" },
      {
        type: "invocation.failed",
        workId: "work-1",
        runId: "run-1",
        invocationId: "task:1",
        error: failure,
        disposition: "fail_run",
      },
      { type: "run.failed", workId: "work-1", runId: "run-1", error: failure },
    ];

    for (const event of seqlaneEvents) bridge.emit(event);
    await bridge.flush();

    expect(events).toEqual([
      { type: "run.started", workId: "work-1", runId: "run-1", metadata },
      {
        type: "invocation.failed",
        workId: "work-1",
        runId: "run-1",
        invocationId: "task:1",
        disposition: "fail_run",
        error: {
          category: "ExecutorError",
          message: 'Task executor failed for "task": private cause',
          taskId: "task",
        },
        metadata: { ...metadata, eventId: "event-2", sequence: 2 },
      },
      {
        type: "run.failed",
        workId: "work-1",
        runId: "run-1",
        error: {
          category: "ExecutorError",
          message: 'Task executor failed for "task": private cause',
          taskId: "task",
        },
        metadata: { ...metadata, eventId: "event-3", sequence: 3 },
      },
    ]);
  });

  it("rejects a successful output that is not JSON serializable", () => {
    const bridge = createExecutionEventBridge(async () => undefined);

    expect(() =>
      bridge.emit({
        type: "run.succeeded",
        workId: "work-1",
        runId: "run-1",
        output: new Date(),
      }),
    ).toThrow("JSON serializable");
  });

  it("emits a canonical plan event in the same sequence", async () => {
    const events: SeqlaneExecutionEvent[] = [];
    const bridge = createExecutionEventBridge(
      async (event) => {
        events.push(event);
      },
      {
        createEventId: (() => {
          let next = 0;
          return () => `event-${++next}`;
        })(),
        clock: () => new Date(metadata.occurredAt),
      },
    );
    const plan: SeqlanePlanSnapshot = {
      workflow: { id: "workflow" },
      nodes: [],
    };

    bridge.emit({ type: "run.started", workId: "work-1", runId: "run-1" });
    bridge.emitPlan(plan, "work-1", "run-1");
    await bridge.flush();

    expect(events.map(({ type }) => type)).toEqual(["run.started", "run.plan"]);
    expect(events[1]).toMatchObject({
      type: "run.plan",
      metadata: { eventId: "event-2", sequence: 2 },
      plan,
    });
  });

  it("forwards adapter observations with protocol metadata", async () => {
    const events: SeqlaneExecutionEvent[] = [];
    const bridge = createExecutionEventBridge(
      async (event) => {
        events.push(event);
      },
      {
        createEventId: () => "observation-event",
        clock: () => new Date(metadata.occurredAt),
      },
    );

    bridge.emitObservation({
      type: "invocation.observation",
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      observationId: "message-1",
      kind: "model",
      state: "succeeded",
      model: {
        request: { text: "request" },
        response: { text: "response" },
      },
    });
    await bridge.flush();

    expect(events).toEqual([
      {
        type: "invocation.observation",
        workId: "work-1",
        runId: "run-1",
        invocationId: "invocation-1",
        observationId: "message-1",
        kind: "model",
        state: "succeeded",
        model: {
          request: { text: "request" },
          response: { text: "response" },
        },
        metadata: { ...metadata, eventId: "observation-event", sequence: 1 },
      },
    ]);
  });

  it("rejects malformed adapter observations before enqueueing them", () => {
    const bridge = createExecutionEventBridge(async () => undefined);
    const malformed = {
      type: "invocation.observation",
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      observationId: "message-1",
      kind: "model",
      state: "succeeded",
      model: { response: { value: new Date() } },
    } as never;

    expect(() => bridge.emitObservation(malformed)).toThrow();
  });

  it("bounds validation failure evidence while preserving canonical error shape", async () => {
    const events: SeqlaneExecutionEvent[] = [];
    const bridge = createExecutionEventBridge(async (event) => {
      events.push(event);
    });
    bridge.emit({
      type: "invocation.failed",
      workId: "work-1",
      runId: "run-1",
      invocationId: "validation:1",
      error: new ValidationFailedError(
        "validation.gate:1",
        "title-quality",
        [{ code: "unsafe", message: "Candidate is unsafe" }],
        { details: "x".repeat(33 * 1024) },
      ),
      disposition: "fail_run",
    });
    await bridge.flush();

    expect(events[0]).toMatchObject({
      type: "invocation.failed",
      metadata: { schemaVersion: 1, sequence: 1 },
      error: {
        category: "ValidationError",
        validation: {
          validationNodeId: "validation.gate:1",
          sourceId: "title-quality",
          evidence: {
            state: "truncated",
            summary: { kind: "object", size: 1, fields: ["details"] },
          },
        },
      },
    });
  });
});
