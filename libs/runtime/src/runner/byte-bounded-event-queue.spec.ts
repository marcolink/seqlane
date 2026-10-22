import { Cause, Deferred, Effect, Fiber, Option } from "effect";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { describe, expect, it } from "vitest";
import {
  createByteBoundedEventQueue,
  type ByteBoundedEventQueue,
  EventQueueClosedError,
  EventQueueDeliveryError,
  EventQueueOverflowError,
  EventQueueSendTimeoutError,
} from "./byte-bounded-event-queue.js";

function event(sequence: number): SeqlaneExecutionEvent {
  return {
    type: "run.heartbeat",
    workId: "work-1",
    runId: "run-1",
    activeInvocationIds: [],
    metadata: {
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: "2026-10-22T00:00:00.000Z",
    },
    elapsedMs: sequence,
  };
}

type SendFailureMode = "typed failure" | "synchronous throw" | "effect defect";

function failingSend(
  mode: SendFailureMode,
  cause: unknown,
): () => Effect.Effect<void, unknown> {
  if (mode === "typed failure") return () => Effect.fail(cause);
  if (mode === "synchronous throw")
    return () => {
      throw cause;
    };
  return () =>
    Effect.sync(() => {
      throw cause;
    });
}

const deliveryFailures = [
  Object.freeze(new Error("frozen transport")),
  "transport",
  null,
  undefined,
];
const sendFailureModes: SendFailureMode[] = [
  "typed failure",
  "synchronous throw",
  "effect defect",
];

describe("byte-bounded execution event queue", () => {
  it("counts queued and in-flight bytes and resumes a waiting producer after ACK", async () => {
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: number[] = [];
    let thirdAdmitted = false;
    let thirdSendObservedAdmission = false;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 8,
            send: (value) =>
              Effect.promise(async () => {
                sent.push(value.metadata.sequence);
                if (value.metadata.sequence === 1) await blocked;
                if (value.metadata.sequence === 3)
                  thirdSendObservedAdmission = thirdAdmitted;
              }),
          });
          yield* queue.offer(event(1), 4);
          yield* queue.offer(event(2), 4);
          let resumed = false;
          const waiting = Effect.runPromise(
            queue.offer(event(3), 4, () => {
              thirdAdmitted = true;
            }),
          ).then(() => {
            resumed = true;
          });
          yield* Effect.promise(() => Promise.resolve());
          expect(resumed).toBe(false);
          expect(thirdAdmitted).toBe(false);
          expect(queue.snapshotPressure()).toEqual({
            maxPendingBytes: 8,
            pendingBytesPeak: 8,
            capacityWaitsTotal: 1,
            overflowsTotal: 0,
          });
          releaseFirst();
          yield* Effect.promise(() => waiting);
          yield* queue.flush();
          expect(sent).toEqual([1, 2, 3]);
          expect(thirdSendObservedAdmission).toBe(true);
          yield* queue.close();
        }),
      ),
    );
  });

  it("waits for acknowledgements again after each idle cycle", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const acknowledgements = [
            Deferred.makeUnsafe<void>(),
            Deferred.makeUnsafe<void>(),
          ];
          const started = [
            Deferred.makeUnsafe<void>(),
            Deferred.makeUnsafe<void>(),
          ];
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: (value) =>
              Effect.gen(function* () {
                const index = value.metadata.sequence - 1;
                yield* Deferred.succeed(started[index]!, undefined);
                yield* Deferred.await(acknowledgements[index]!);
              }),
          });
          for (const index of [0, 1]) {
            queue.offerCallback(event(index + 1), 4);
            yield* Deferred.await(started[index]!);
            let flushed = false;
            const flush = yield* Effect.forkChild(
              queue.flush().pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    flushed = true;
                  }),
                ),
              ),
            );
            yield* Effect.yieldNow;
            expect(flushed).toBe(false);
            yield* Deferred.succeed(acknowledgements[index]!, undefined);
            yield* Fiber.join(flush);
            expect(flushed).toBe(true);
          }
        }),
      ),
    );
  });

  it("notifies once on callback overflow and keeps the first failure", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const laterFailure = new Error("later delivery failure");
    const reported: unknown[] = [];
    let waitingAdmissionCount = 0;
    let overflow: unknown;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: (value) =>
              Effect.promise(async () => {
                await blocked;
                throw laterFailure;
              }),
            onDeliveryFailure: (cause) => {
              reported.push(cause);
              throw new Error("observer failure");
            },
          });
          yield* queue.offer(event(1), 4);
          const waiting = Effect.runFork(
            queue.offer(event(2), 1, () => {
              waitingAdmissionCount += 1;
            }),
          );
          yield* Effect.sleep("5 millis");
          try {
            queue.offerCallback(event(2), 1);
          } catch (cause) {
            overflow = cause;
          }
          expect(overflow).toBeInstanceOf(EventQueueOverflowError);
          expect(queue.snapshotPressure().overflowsTotal).toBe(1);
          expect(reported).toEqual([overflow]);
          const waitingResult = yield* Effect.result(
            Fiber.join(waiting).pipe(Effect.timeoutOption("100 millis")),
          );
          expect(waitingResult._tag).toBe("Failure");
          if (waitingResult._tag === "Failure") {
            expect(waitingResult.failure).toBeInstanceOf(
              EventQueueDeliveryError,
            );
            expect(waitingResult.failure.cause).toBe(overflow);
          }
          expect(waitingAdmissionCount).toBe(0);
          release();
          const result = yield* queue.settle();
          expect(Option.isSome(result)).toBe(true);
          if (Option.isSome(result)) expect(result.value.cause).toBe(overflow);
          expect(reported).toEqual([overflow]);
          yield* queue.close().pipe(Effect.ignore);
        }),
      ),
    );
  });

  it("keeps accepted events in FIFO order while an earlier ACK is slow", async () => {
    const sent: number[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const firstStarted = yield* Deferred.make<void>();
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 12,
            send: (value) =>
              Effect.gen(function* () {
                sent.push(value.metadata.sequence);
                if (value.metadata.sequence === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(release);
                }
              }),
          });
          yield* queue.offer(event(1), 4);
          yield* queue.offer(event(2), 4);
          yield* queue.offer(event(3), 4);
          yield* Deferred.await(firstStarted);
          expect(sent).toEqual([1]);
          yield* Deferred.succeed(release, undefined);
          yield* queue.flush();
          expect(sent).toEqual([1, 2, 3]);
          yield* queue.close();
        }),
      ),
    );
  });

  it.each(
    deliveryFailures.flatMap((cause) =>
      sendFailureModes.map((mode) => [mode, cause] as const),
    ),
  )("preserves %s cause for normal delivery: %s", async (mode, cause) => {
    const reported: unknown[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: failingSend(mode, cause),
            onDeliveryFailure: (failure) => reported.push(failure),
          });
          yield* queue.offer(event(1), 4);
          const settled = yield* queue
            .settle()
            .pipe(Effect.timeoutOption("250 millis"));
          expect(Option.isSome(settled)).toBe(true);
          if (Option.isSome(settled)) {
            expect(Option.isSome(settled.value)).toBe(true);
            if (Option.isSome(settled.value)) {
              expect(settled.value.value).toBeInstanceOf(
                EventQueueDeliveryError,
              );
              expect(Object.hasOwn(settled.value.value, "cause")).toBe(true);
              expect(settled.value.value.cause).toBe(cause);
            }
          }
          expect(reported).toEqual([cause]);
        }),
      ),
    );
  });

  it("preserves composite delivery causes with every reason", async () => {
    const primary = new Error("typed transport failure");
    const secondary = Object.freeze(new Error("transport defect"));
    const composite = Cause.combine(Cause.fail(primary), Cause.die(secondary));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: () => Effect.failCause(composite),
          });
          yield* queue.offer(event(1), 4);
          const settled = yield* queue.settle();
          expect(Option.isSome(settled)).toBe(true);
          if (Option.isSome(settled))
            expect(settled.value.cause).toBe(composite);
        }),
      ),
    );
  });

  it("removes an interrupted capacity waiter before a later ACK admits work", async () => {
    const sent: number[] = [];
    let interruptedAdmissionCount = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstAck = yield* Deferred.make<void>();
          const firstStarted = yield* Deferred.make<void>();
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: (value) =>
              Effect.gen(function* () {
                sent.push(value.metadata.sequence);
                if (value.metadata.sequence === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(firstAck);
                }
              }),
          });
          yield* queue.offer(event(1), 4);
          yield* Deferred.await(firstStarted);
          const cancelled = Effect.runFork(
            queue.offer(event(2), 4, () => {
              interruptedAdmissionCount += 1;
            }),
          );
          yield* Effect.sleep("5 millis");
          const interruptResult = yield* Fiber.interrupt(cancelled).pipe(
            Effect.timeoutOption("100 millis"),
          );
          expect(Option.isSome(interruptResult)).toBe(true);
          expect(interruptedAdmissionCount).toBe(0);
          yield* Deferred.succeed(firstAck, undefined);
          yield* queue.offer(event(3), 4);
          const flushed = yield* queue
            .flush()
            .pipe(Effect.timeoutOption("100 millis"));
          expect(Option.isSome(flushed)).toBe(true);
          expect(sent).toEqual([1, 3]);
          yield* queue.close();
        }),
      ),
    );
  });

  it("rejects oversized events and invalid byte counts without waiting", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const notified: unknown[] = [];
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: () => Effect.void,
            onDeliveryFailure: (cause) => notified.push(cause),
          });
          const oversizedOffer = queue.offer(event(1), 5);
          expect(notified).toHaveLength(0);
          const tooLarge = yield* Effect.result(oversizedOffer);
          const invalid = yield* Effect.result(queue.offer(event(2), 0));
          expect(tooLarge._tag).toBe("Failure");
          expect(invalid._tag).toBe("Failure");
          if (tooLarge._tag === "Failure") {
            expect(tooLarge.failure).toBeInstanceOf(EventQueueDeliveryError);
            expect(tooLarge.failure.cause).toBeInstanceOf(
              EventQueueOverflowError,
            );
            expect(notified[0]).toBe(tooLarge.failure.cause);
          }
          expect(notified).toHaveLength(1);
          if (invalid._tag === "Failure")
            expect(invalid.failure).toBeInstanceOf(RangeError);
          yield* queue.close().pipe(Effect.ignore);
        }),
      ),
    );
  });

  it("bounds a send that never acknowledges", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            sendTimeoutMs: 10,
            send: () => Effect.never,
          });
          yield* queue.offer(event(1), 4);
          const failure = yield* queue.settle();
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(EventQueueDeliveryError);
            expect(failure.value.cause).toBeInstanceOf(
              EventQueueSendTimeoutError,
            );
          }
        }),
      ),
    );
  });

  it("sends a terminal event after failed delivery and rejects later offers", async () => {
    const sent: number[] = [];
    const cause = new Error("broken transport");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: (value) => {
              sent.push(value.metadata.sequence);
              return value.type === "run.failed"
                ? Effect.void
                : Effect.fail(cause);
            },
          });
          yield* queue.offer(event(1), 4);
          const terminalResult = yield* Effect.result(
            queue.sendTerminal({
              type: "run.failed",
              workId: "work-1",
              runId: "run-1",
              error: { category: "RuntimeError", message: "failed" },
              metadata: {
                schemaVersion: 1,
                eventId: "terminal",
                sequence: 2,
                occurredAt: "2026-10-22T00:00:00.000Z",
              },
            }),
          );
          expect(terminalResult._tag).toBe("Failure");
          expect(sent).toEqual([1, 2]);
          const later = yield* Effect.result(queue.offer(event(3), 1));
          expect(later._tag).toBe("Failure");
          if (later._tag === "Failure")
            expect(later.failure).toBeInstanceOf(EventQueueClosedError);
        }),
      ),
    );
  });

  it("seals admission before a successful terminal send", async () => {
    const sent: number[] = [];
    const terminal: SeqlaneExecutionEvent = {
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: {},
      metadata: {
        schemaVersion: 1,
        eventId: "terminal",
        sequence: 2,
        occurredAt: "2026-10-22T00:00:00.000Z",
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: (value) => {
              sent.push(value.metadata.sequence);
              return Effect.void;
            },
          });
          yield* queue.sendTerminal(terminal);
          const later = yield* Effect.result(queue.offer(event(3), 1));
          expect(later._tag).toBe("Failure");
          expect(sent).toEqual([2]);
        }),
      ),
    );
  });

  it("reports terminal send failures and timeouts", async () => {
    const cause = "terminal transport";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            sendTimeoutMs: 10,
            send: () => Effect.fail(cause),
          });
          const result = yield* Effect.result(queue.sendTerminal(event(1)));
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.cause).toBe(cause);
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            sendTimeoutMs: 10,
            send: () => Effect.never,
          });
          const result = yield* Effect.result(queue.sendTerminal(event(1)));
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.cause).toBeInstanceOf(
              EventQueueSendTimeoutError,
            );
        }),
      ),
    );
  });

  it.each(
    deliveryFailures.flatMap((cause) =>
      sendFailureModes.map((mode) => [mode, cause] as const),
    ),
  )("preserves %s cause for terminal delivery: %s", async (mode, cause) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: failingSend(mode, cause),
          });
          const result = yield* Effect.result(
            queue
              .sendTerminal(event(1))
              .pipe(Effect.timeoutOption("250 millis")),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(EventQueueDeliveryError);
            expect(Object.hasOwn(result.failure, "cause")).toBe(true);
            expect(result.failure.cause).toBe(cause);
          }
        }),
      ),
    );
  });

  it("bounds close and scope cleanup when a send never acknowledges", async () => {
    const started = Date.now();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            sendTimeoutMs: 10,
            send: () => Effect.never,
          });
          yield* queue.offer(event(1), 4);
          const closed = yield* Effect.result(queue.close());
          expect(closed._tag).toBe("Failure");
        }),
      ),
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("commits in-flight byte reservations before synchronous callback reentrancy", async () => {
    let queueRef: ByteBoundedEventQueue | undefined;
    let reentrantFailure: unknown;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 1,
            send: () => {
              try {
                queueRef?.offerCallback(event(2), 1);
              } catch (cause) {
                reentrantFailure = cause;
              }
              return Effect.void;
            },
          });
          queueRef = queue;
          queue.offerCallback(event(1), 1);
          yield* queue.settle();
          expect(reentrantFailure).toBeInstanceOf(EventQueueOverflowError);
          yield* queue.close().pipe(Effect.ignore);
        }),
      ),
    );
  });

  it("runs the admission hook before the drain can reenter the callback producer", async () => {
    let queueRef: ByteBoundedEventQueue | undefined;
    let committedSequence = 0;
    let observedCommittedSequence = 0;
    let hookCalls = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: (value) => {
              if (value.metadata.sequence === 1) {
                observedCommittedSequence = committedSequence;
                queueRef?.offerCallback(event(2), 1);
              }
              return Effect.void;
            },
          });
          queueRef = queue;
          queue.offerCallback(event(1), 1, () => {
            hookCalls += 1;
            committedSequence = 1;
          });
          yield* queue.flush();
          expect(observedCommittedSequence).toBe(1);
          expect(hookCalls).toBe(1);
          yield* queue.close();
        }),
      ),
    );
  });

  it("releases a reservation when the admission hook throws", async () => {
    const hookFailure = new Error("admission hook failed");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 1,
            send: () => Effect.void,
          });
          let thrown: unknown;
          try {
            queue.offerCallback(event(1), 1, () => {
              throw hookFailure;
            });
          } catch (cause) {
            thrown = cause;
          }
          expect(thrown).toBe(hookFailure);
          const flushed = yield* queue
            .flush()
            .pipe(Effect.timeoutOption("100 millis"));
          expect(Option.isSome(flushed)).toBe(true);
          queue.offerCallback(event(2), 1);
          const settled = yield* queue
            .settle()
            .pipe(Effect.timeoutOption("100 millis"));
          expect(Option.isSome(settled)).toBe(true);
          yield* queue.close();
        }),
      ),
    );
  });

  it("closes admission after draining accepted work", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* createByteBoundedEventQueue({
            maxPendingBytes: 4,
            send: () => Effect.void,
          });
          yield* queue.offer(event(1), 4);
          yield* queue.close();
          const rejected = yield* Effect.result(queue.offer(event(2), 1));
          expect(rejected._tag).toBe("Failure");
          if (rejected._tag === "Failure")
            expect(rejected.failure).toBeInstanceOf(EventQueueClosedError);
        }),
      ),
    );
  });
});
