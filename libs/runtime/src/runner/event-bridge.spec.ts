// @test-scope ./event-bridge.ts
import {
  ExecutorError,
  ValidationFailedError,
  type SeqlaneEvent,
} from "@seqlane/core";
import type {
  SeqlaneExecutionEvent,
  SeqlanePlanSnapshot,
} from "@seqlane/protocol";
import { encodeSeqlaneExecutionEvent } from "@seqlane/protocol";
import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  createExecutionEventBridge,
  NonSerializableRunOutputError,
} from "./event-bridge.js";
import {
  createByteBoundedEventQueue,
  EventQueueDeliveryError,
} from "./byte-bounded-event-queue.js";

const metadata = {
  schemaVersion: 1 as const,
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-08-18T00:00:00.000Z",
};

describe("execution event bridge", () => {
  it("sends async interaction controls through canonical event sequencing", async () => {
    const events: SeqlaneExecutionEvent[] = [];
    const bridge = createExecutionEventBridge(async (event) => {
      events.push(event);
    });

    await bridge.emitAsync({
      type: "interaction.requested",
      workId: "work-1",
      runId: "run-1",
      invocationId: "task:1",
      subject: { type: "task", taskId: "task-1" },
      taskId: "task-1",
      requestId: "question-1",
      kind: "user-input",
      questions: [{ id: "region", prompt: "Region?", allowFreeText: true }],
      expiresAt: "2026-10-24T00:00:00.000Z",
    });
    await bridge.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "interaction.requested",
      requestId: "question-1",
      metadata: { sequence: 1 },
    });
    expect(events[0]?.metadata.eventId).toBeTruthy();
  });

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
    ).toThrow(NonSerializableRunOutputError);
  });

  it("bounds queued bytes and drains accepted events before failing", async () => {
    const events: SeqlaneExecutionEvent[] = [];
    let releaseFirst!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sample: SeqlaneExecutionEvent = {
      type: "run.started",
      workId: "work-1",
      runId: "run-1",
      metadata: {
        schemaVersion: 1,
        eventId: "event-1",
        sequence: 1,
        occurredAt: metadata.occurredAt,
      },
    };
    const bridge = createExecutionEventBridge(
      async (event) => {
        events.push(event);
        if (events.length === 1) await firstSend;
      },
      {
        maxPendingBytes:
          Buffer.byteLength(encodeSeqlaneExecutionEvent(sample), "utf8") * 2,
        createEventId: () => "event-1",
        clock: () => new Date(metadata.occurredAt),
      },
    );
    const event: SeqlaneEvent = {
      type: "run.started",
      workId: "work-1",
      runId: "run-1",
    };

    bridge.emit(event);
    bridge.emit(event);
    expect(() => bridge.emit(event)).toThrow("Execution event queue exceeded");

    const flushed = bridge.flush();
    releaseFirst();
    await expect(flushed).rejects.toMatchObject({
      name: "ExecutionEventQueueOverflowError",
    });
    expect(
      events.map(({ metadata: eventMetadata }) => eventMetadata?.sequence),
    ).toEqual([1, 2]);

    expect(await bridge.settle()).toMatchObject({
      name: "ExecutionEventQueueOverflowError",
    });
    await bridge.sendTerminal({
      type: "run.failed",
      workId: "work-1",
      runId: "run-1",
      error: new ExecutorError("task", new Error("overflow")),
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      metadata: { sequence: 3 },
    });
  });

  it("captures immutable canonical payload bytes before callback delivery", async () => {
    const delivered: SeqlaneExecutionEvent[] = [];
    const encodedEvents = new WeakMap<SeqlaneExecutionEvent, string>();
    const bridge = createExecutionEventBridge(
      async (event) => {
        delivered.push(event);
      },
      { encodedEvents },
    );
    const output = { text: "é", enabled: false, count: 0 };

    bridge.emit({
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output,
    });
    output.text = "changed";
    output.enabled = true;
    await bridge.flush();

    const accepted = delivered[0];
    expect(accepted).toMatchObject({
      output: { text: "é", enabled: false, count: 0 },
    });
    expect(encodedEvents.get(accepted!)).toBe(
      encodeSeqlaneExecutionEvent(accepted!),
    );
    expect(
      Buffer.byteLength(encodedEvents.get(accepted!)!, "utf8"),
    ).toBeGreaterThan(
      Buffer.byteLength(
        JSON.stringify({ text: "e", enabled: false, count: 0 }),
        "utf8",
      ),
    );
  });

  it("assigns unique ordered sequences across native and reentrant producers", async () => {
    const delivered: SeqlaneExecutionEvent[] = [];
    let reentered = false;
    let bridge!: ReturnType<typeof createExecutionEventBridge>;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 10_000,
            send: (event) =>
              Effect.sync(() => {
                delivered.push(event);
                if (!reentered) {
                  reentered = true;
                  bridge.emit({
                    type: "run.heartbeat",
                    workId: "work-1",
                    runId: "run-1",
                    activeInvocationIds: [],
                    elapsedMs: 0,
                  });
                }
              }),
          });
          bridge = createExecutionEventBridge(async () => undefined, { queue });
          yield* Effect.all(
            [
              bridge.emitEffect({
                type: "run.started",
                workId: "work-1",
                runId: "run-1",
              }),
              bridge.emitEffect({
                type: "run.heartbeat",
                workId: "work-1",
                runId: "run-1",
                activeInvocationIds: [],
                elapsedMs: 0,
              }),
            ],
            { concurrency: "unbounded" },
          );
          yield* queue.flush();
        }),
      ),
    );
    expect(delivered.map((event) => event.metadata.sequence)).toEqual([
      1, 2, 3,
    ]);
  });

  it("does not consume a sequence when a capacity-blocked native offer is interrupted", async () => {
    const delivered: SeqlaneExecutionEvent[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseSend = yield* Deferred.make<void>();
          const firstStarted = yield* Deferred.make<void>();
          const later = {
            type: "run.heartbeat" as const,
            workId: "work-1",
            runId: "run-1",
            activeInvocationIds: [],
            elapsedMs: 0,
            metadata: { ...metadata, eventId: "event-123", sequence: 2 },
          };
          const capacity = Buffer.byteLength(
            encodeSeqlaneExecutionEvent(later),
            "utf8",
          );
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: capacity,
            send: (event) =>
              Effect.gen(function* () {
                delivered.push(event);
                if (event.metadata.sequence === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseSend);
                }
              }),
          });
          const bridge = createExecutionEventBridge(async () => undefined, {
            queue,
            createEventId: () => "event-123",
            clock: () => new Date(metadata.occurredAt),
          });
          yield* bridge.emitEffect({
            type: "run.started",
            workId: "work-1",
            runId: "run-1",
          });
          yield* Deferred.await(firstStarted);
          const blocked = Effect.runFork(
            bridge.emitEffect({
              type: "run.heartbeat",
              workId: "work-1",
              runId: "run-1",
              activeInvocationIds: [],
              elapsedMs: 0,
            }),
          );
          yield* Effect.sleep("5 millis");
          yield* Fiber.interrupt(blocked);
          yield* Deferred.succeed(releaseSend, undefined);
          yield* queue.flush();
          yield* bridge.emitEffect({
            type: "run.heartbeat",
            workId: "work-1",
            runId: "run-1",
            activeInvocationIds: [],
            elapsedMs: 0,
          });
          yield* queue.flush();
        }),
      ),
    );
    expect(delivered.map((event) => event.metadata.sequence)).toEqual([1, 2]);
  }, 15_000);

  it("reports a callback rejected while native admission is pending", async () => {
    const delivered: SeqlaneExecutionEvent[] = [];
    const reported: unknown[] = [];
    let failure: unknown;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseSend = yield* Deferred.make<void>();
          const firstStarted = yield* Deferred.make<void>();
          const later = {
            type: "run.heartbeat" as const,
            workId: "work-1",
            runId: "run-1",
            activeInvocationIds: [],
            elapsedMs: 0,
            metadata: { ...metadata, eventId: "event-123", sequence: 2 },
          };
          const capacity = Buffer.byteLength(
            encodeSeqlaneExecutionEvent(later),
            "utf8",
          );
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: capacity,
            send: (event) =>
              Effect.gen(function* () {
                delivered.push(event);
                if (event.metadata.sequence === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseSend);
                }
              }),
            onDeliveryFailure: (cause) => reported.push(cause),
          });
          const bridge = createExecutionEventBridge(async () => undefined, {
            queue,
            createEventId: () => "event-123",
            clock: () => new Date(metadata.occurredAt),
          });
          yield* bridge.emitEffect({
            type: "run.started",
            workId: "work-1",
            runId: "run-1",
          });
          yield* Deferred.await(firstStarted);
          const blocked = Effect.runFork(
            bridge.emitEffect({
              type: "run.heartbeat",
              workId: "work-1",
              runId: "run-1",
              activeInvocationIds: [],
              elapsedMs: 0,
            }),
          );
          yield* Effect.sleep("5 millis");
          try {
            bridge.emit({
              type: "run.heartbeat",
              workId: "work-1",
              runId: "run-1",
              activeInvocationIds: [],
              elapsedMs: 0,
            });
          } catch (cause) {
            failure = cause;
          }
          yield* Deferred.succeed(releaseSend, undefined);
          expect(failure).toBeInstanceOf(Error);
          expect(reported).toEqual([failure]);
          const blockedResult = yield* Effect.result(
            Fiber.join(blocked).pipe(Effect.timeoutOption("100 millis")),
          );
          expect(blockedResult._tag).toBe("Failure");
          if (blockedResult._tag === "Failure") {
            expect(blockedResult.failure).toBeInstanceOf(
              EventQueueDeliveryError,
            );
            expect(blockedResult.failure.cause).toBe(failure);
          }
          const settled = yield* queue.settle();
          expect(Option.isSome(settled)).toBe(true);
          if (Option.isSome(settled)) expect(settled.value.cause).toBe(failure);
          expect(delivered.map((event) => event.metadata.sequence)).toEqual([
            1,
          ]);
          expect(reported).toEqual([failure]);
          yield* queue.close().pipe(Effect.ignore);
        }),
      ),
    );
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

  it("adds validated parent context to canonical event metadata", async () => {
    const events: SeqlaneExecutionEvent[] = [];
    const bridge = createExecutionEventBridge(
      async (event) => {
        events.push(event);
      },
      {
        traceCarrier: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value",
        },
      },
    );

    bridge.emit({ type: "run.started", workId: "work-1", runId: "run-1" });
    await bridge.flush();

    expect(events[0]?.metadata).toMatchObject({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
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

  it("preserves full validation failure evidence while preserving canonical error shape", async () => {
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
            state: "present",
            value: { details: "x".repeat(33 * 1024) },
          },
        },
      },
    });
  });
});
