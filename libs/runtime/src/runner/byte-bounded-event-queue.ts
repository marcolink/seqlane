import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Latch,
  Option,
  Queue,
  Scope,
} from "effect";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { z } from "zod";

const DEFAULT_SEND_TIMEOUT_MS = 5_000;

const STOP = Symbol("stop-event-drain");

export class EventQueueClosedError extends Error {
  constructor() {
    super("Execution event queue is closed");
    this.name = "EventQueueClosedError";
  }
}

export class EventQueueOverflowError extends Error {
  constructor(readonly maxPendingBytes: number) {
    super(`Execution event queue exceeded ${maxPendingBytes} bytes`);
    this.name = "EventQueueOverflowError";
  }
}

export class EventQueueDeliveryError extends Error {
  constructor(cause: unknown) {
    super("Execution event delivery failed", { cause });
    this.name = "EventQueueDeliveryError";
  }
}

export class EventQueueSendTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Execution event send exceeded ${timeoutMs} ms`);
    this.name = "EventQueueSendTimeoutError";
  }
}

function succeedDeferred<E>(deferred: Deferred.Deferred<void, E>): void {
  Deferred.doneUnsafe(deferred, Effect.succeed(undefined));
}

function failDeferred(
  deferred: Deferred.Deferred<void, Error>,
  error: Error,
): void {
  Deferred.doneUnsafe(deferred, Effect.fail(error));
}

export interface ByteBoundedEventQueue {
  /** Accept an event, waiting for byte capacity when required. */
  offer(
    event: SeqlaneExecutionEvent,
    encodedBytes: number,
    onAdmitted?: () => void,
  ): Effect.Effect<void, Error>;
  /** Accept synchronously or fail the callback producer on overflow. */
  offerCallback(
    event: SeqlaneExecutionEvent,
    encodedBytes: number,
    onAdmitted?: () => void,
  ): void;
  /** Wait for all events accepted before this call to receive acknowledgements. */
  flush(): Effect.Effect<void, Error>;
  /** Wait for accepted work and return its delivery failure, if any. */
  settle(): Effect.Effect<Option.Option<Error>>;
  /** Record a required-stream failure detected by an owning producer. */
  reportFailure(cause: unknown): void;
  /** Stop admission, settle accepted work, then send the terminal event. */
  sendTerminal(event: SeqlaneExecutionEvent): Effect.Effect<void, Error>;
  /** Stop admission and finish accepted work with a bounded wait. */
  close(): Effect.Effect<void, Error>;
  /** Return bounded queue-pressure totals for private telemetry. */
  snapshotPressure(): EventQueuePressure;
}

export interface EventQueuePressure {
  readonly maxPendingBytes: number;
  readonly pendingBytesPeak: number;
  readonly capacityWaitsTotal: number;
  readonly overflowsTotal: number;
}

export interface ByteBoundedEventQueueOptions {
  readonly maxPendingBytes: number;
  readonly send: (event: SeqlaneExecutionEvent) => Effect.Effect<void, unknown>;
  readonly sendTimeoutMs?: number;
  /** Notify the owning run when required event delivery fails. */
  readonly onDeliveryFailure?: (cause: unknown) => void;
}

interface Entry {
  readonly event: SeqlaneExecutionEvent;
  readonly bytes: number;
}

interface CapacityWaiter {
  // Waiting producers retain demand only. Admission reserves bytes before waking them.
  readonly bytes: number;
  readonly ready: Deferred.Deferred<void, Error>;
  admitted: boolean;
}

type Message = Entry | typeof STOP;

interface State {
  pendingBytes: number;
  pendingBytesPeak: number;
  capacityWaitsTotal: number;
  overflowsTotal: number;
  outstanding: number;
  readonly idle: Latch.Latch;
  readonly capacityWaiters: CapacityWaiter[];
  failure: { readonly cause: unknown } | undefined;
  transportFailed: boolean;
  closed: boolean;
  terminal: boolean;
  storageReleased: boolean;
}

const encodedBytesSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

function errorFromFailure(failure: State["failure"]): Error | undefined {
  return failure === undefined
    ? undefined
    : new EventQueueDeliveryError(failure.cause);
}

function validateCapacity(
  maxPendingBytes: number,
  sendTimeoutMs: number,
): void {
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
    throw new RangeError("maxPendingBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1) {
    throw new RangeError("sendTimeoutMs must be a positive safe integer");
  }
}

function asDeliveryCause(
  exit: Exit.Exit<Option.Option<void>, unknown>,
): unknown | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const reasons = exit.cause.reasons;
  if (reasons.length !== 1) return exit.cause;
  const reason = reasons[0];
  if (reason === undefined) return exit.cause;
  if (Cause.isFailReason(reason)) return reason.error;
  if (Cause.isDieReason(reason)) return reason.defect;
  return exit.cause;
}

function sendWithTimeout(
  send: ByteBoundedEventQueueOptions["send"],
  event: SeqlaneExecutionEvent,
  timeoutMs: number,
): Effect.Effect<Exit.Exit<Option.Option<void>, unknown>, never> {
  const invoked = Effect.suspend(() => send(event));
  return Effect.exit(invoked.pipe(Effect.timeoutOption(`${timeoutMs} millis`)));
}

function createAdmission(
  state: State,
  messages: Queue.Queue<Message>,
  maxPendingBytes: number,
  onDeliveryFailure: ByteBoundedEventQueueOptions["onDeliveryFailure"],
) {
  const enqueueReserved = (entry: Entry, onAdmitted?: () => void): void => {
    try {
      onAdmitted?.();
      Queue.offerUnsafe(messages, entry);
    } catch (cause) {
      release(entry.bytes);
      throw cause;
    }
  };

  const admit = (entry: Entry, onAdmitted?: () => void): Error | undefined => {
    if (state.terminal || state.closed) return new EventQueueClosedError();
    if (state.failure !== undefined) return errorFromFailure(state.failure);
    if (entry.bytes > maxPendingBytes) {
      return new EventQueueOverflowError(maxPendingBytes);
    }
    state.pendingBytes += entry.bytes;
    state.pendingBytesPeak = Math.max(
      state.pendingBytesPeak,
      state.pendingBytes,
    );
    state.outstanding += 1;
    if (state.outstanding === 1) state.idle.closeUnsafe();
    enqueueReserved(entry, onAdmitted);
    return undefined;
  };

  const unregister = (waiter: CapacityWaiter): void => {
    const index = state.capacityWaiters.indexOf(waiter);
    if (index >= 0) state.capacityWaiters.splice(index, 1);
  };

  const release = (bytes: number): void => {
    if (state.storageReleased) return;
    state.pendingBytes -= bytes;
    state.outstanding -= 1;
    if (state.outstanding === 0) state.idle.openUnsafe();
    wakeWaiters();
  };

  const wakeWaiters = (): void => {
    while (state.capacityWaiters.length > 0) {
      if (state.failure !== undefined || state.closed || state.terminal) return;
      const waiter = state.capacityWaiters[0];
      if (
        waiter === undefined ||
        state.pendingBytes + waiter.bytes > maxPendingBytes
      )
        return;
      state.capacityWaiters.shift();
      waiter.admitted = true;
      state.pendingBytes += waiter.bytes;
      state.pendingBytesPeak = Math.max(
        state.pendingBytesPeak,
        state.pendingBytes,
      );
      state.outstanding += 1;
      if (state.outstanding === 1) state.idle.closeUnsafe();
      succeedDeferred(waiter.ready);
    }
  };

  const cancel = (waiter: CapacityWaiter): void => {
    unregister(waiter);
    if (waiter.admitted) {
      waiter.admitted = false;
      release(waiter.bytes);
    }
  };

  const rejectWaiters = (error: Error): void => {
    for (const waiter of state.capacityWaiters.splice(0))
      failDeferred(waiter.ready, error);
  };

  const recordFailure = (cause: unknown, stopTransport: boolean): Error => {
    const isFirstFailure = state.failure === undefined;
    state.failure ??= { cause };
    if (stopTransport) state.transportFailed = true;
    if (isFirstFailure) {
      try {
        onDeliveryFailure?.(cause);
      } catch {
        // Failure notification must not replace the original queue cause.
      }
    }
    const error =
      errorFromFailure(state.failure) ?? new EventQueueClosedError();
    rejectWaiters(error);
    return error;
  };

  const rejectOversized = (): Error => {
    if (state.terminal || state.closed) return new EventQueueClosedError();
    if (state.failure !== undefined)
      return errorFromFailure(state.failure) ?? new EventQueueClosedError();
    state.overflowsTotal += 1;
    return recordFailure(new EventQueueOverflowError(maxPendingBytes), false);
  };

  const offer = (
    event: SeqlaneExecutionEvent,
    bytes: number,
    onAdmitted?: () => void,
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const decision = yield* Effect.sync(() => {
        if (state.terminal || state.closed)
          return {
            _tag: "Rejected" as const,
            error: new EventQueueClosedError(),
          };
        if (state.failure !== undefined)
          return {
            _tag: "Rejected" as const,
            error:
              errorFromFailure(state.failure) ?? new EventQueueClosedError(),
          };
        if (
          state.capacityWaiters.length === 0 &&
          state.pendingBytes + bytes <= maxPendingBytes
        ) {
          const error = admit({ event, bytes }, onAdmitted);
          return error === undefined
            ? { _tag: "Accepted" as const }
            : { _tag: "Rejected" as const, error };
        }
        state.capacityWaitsTotal += 1;
        const waiter: CapacityWaiter = {
          bytes,
          ready: Deferred.makeUnsafe<void, Error>(),
          admitted: false,
        };
        state.capacityWaiters.push(waiter);
        return { _tag: "Waiting" as const, waiter };
      });
      if (decision._tag === "Rejected")
        return yield* Effect.fail(decision.error);
      if (decision._tag === "Accepted") return;
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.onInterrupt(
          restore(Deferred.await(decision.waiter.ready)).pipe(
            Effect.flatMap(() =>
              Effect.sync(() => {
                decision.waiter.admitted = false;
                enqueueReserved(
                  {
                    event,
                    bytes: decision.waiter.bytes,
                  },
                  onAdmitted,
                );
              }),
            ),
          ),
          () => Effect.sync(() => cancel(decision.waiter)),
        ),
      );
    });

  const offerCallback = (
    event: SeqlaneExecutionEvent,
    bytes: number,
    onAdmitted?: () => void,
  ): void => {
    if (state.terminal || state.closed) throw new EventQueueClosedError();
    if (state.failure !== undefined) throw errorFromFailure(state.failure);
    if (
      state.capacityWaiters.length > 0 ||
      state.pendingBytes + bytes > maxPendingBytes
    ) {
      state.overflowsTotal += 1;
      const overflow = new EventQueueOverflowError(maxPendingBytes);
      recordFailure(overflow, false);
      throw overflow;
    }
    const error = admit({ event, bytes }, onAdmitted);
    if (error !== undefined) throw error;
  };

  return {
    offer,
    offerCallback,
    release,
    fail(cause: unknown) {
      recordFailure(cause, true);
    },
    reportFailure(cause: unknown) {
      if (!state.closed && !state.terminal) recordFailure(cause, false);
    },
    rejectOversized,
    seal() {
      state.closed = true;
      state.terminal = true;
      rejectWaiters(new EventQueueClosedError());
    },
    releaseStorage() {
      state.storageReleased = true;
      state.pendingBytes = 0;
      state.outstanding = 0;
      state.idle.openUnsafe();
      Queue.shutdownUnsafe(messages);
    },
  };
}

function makeDrain(
  messages: Queue.Queue<Message>,
  state: State,
  admission: ReturnType<typeof createAdmission>,
  options: ByteBoundedEventQueueOptions,
  sendTimeoutMs: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const message = yield* Queue.take(messages);
      if (message === STOP) return;
      if (state.transportFailed) {
        admission.release(message.bytes);
        continue;
      }
      const result = yield* sendWithTimeout(
        options.send,
        message.event,
        sendTimeoutMs,
      );
      if (Exit.isFailure(result)) admission.fail(asDeliveryCause(result));
      else if (Option.isNone(result.value))
        admission.fail(new EventQueueSendTimeoutError(sendTimeoutMs));
      admission.release(message.bytes);
    }
  });
}

/**
 * Queue canonical events by their already-encoded UTF-8 byte size. The drain
 * owns delivery and releases reservations only after an acknowledgement.
 */
export function createByteBoundedEventQueue(
  options: ByteBoundedEventQueueOptions,
): Effect.Effect<ByteBoundedEventQueue, never, Scope.Scope> {
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  validateCapacity(options.maxPendingBytes, sendTimeoutMs);

  return Effect.gen(function* () {
    const messages = yield* Queue.unbounded<Message>();
    const state: State = {
      pendingBytes: 0,
      pendingBytesPeak: 0,
      capacityWaitsTotal: 0,
      overflowsTotal: 0,
      outstanding: 0,
      idle: Latch.makeUnsafe(true),
      capacityWaiters: [],
      failure: undefined,
      transportFailed: false,
      closed: false,
      terminal: false,
      storageReleased: false,
    };

    const admission = createAdmission(
      state,
      messages,
      options.maxPendingBytes,
      options.onDeliveryFailure,
    );
    yield* Effect.forkScoped(
      makeDrain(messages, state, admission, options, sendTimeoutMs),
    );

    const queue: ByteBoundedEventQueue = {
      offer(event, encodedBytes, onAdmitted) {
        if (!encodedBytesSchema.safeParse(encodedBytes).success) {
          return Effect.fail(
            new RangeError("encodedBytes must be a positive safe integer"),
          );
        }
        if (encodedBytes > options.maxPendingBytes) {
          return Effect.suspend(() => Effect.fail(admission.rejectOversized()));
        }
        return admission.offer(event, encodedBytes, onAdmitted);
      },
      offerCallback(event, encodedBytes, onAdmitted) {
        if (!encodedBytesSchema.safeParse(encodedBytes).success)
          throw new RangeError("encodedBytes must be a positive safe integer");
        admission.offerCallback(event, encodedBytes, onAdmitted);
      },
      flush() {
        return Effect.gen(function* () {
          yield* state.idle.await;
          const failure = errorFromFailure(state.failure);
          if (failure !== undefined) return yield* Effect.fail(failure);
        });
      },
      settle() {
        return Effect.gen(function* () {
          yield* state.idle.await;
          return state.failure === undefined
            ? Option.none()
            : Option.some(new EventQueueDeliveryError(state.failure.cause));
        });
      },
      reportFailure(cause) {
        admission.reportFailure(cause);
      },
      sendTerminal(event) {
        return Effect.gen(function* () {
          const alreadyTerminal = yield* Effect.sync(() => {
            if (state.terminal) return true;
            admission.seal();
            return false;
          });
          if (alreadyTerminal)
            return yield* Effect.fail(new EventQueueClosedError());
          const settled = yield* queue.settle();
          // Terminal delivery is intentionally outside the failed queue, but still bounded.
          const result = yield* sendWithTimeout(
            options.send,
            event,
            sendTimeoutMs,
          );
          if (Exit.isFailure(result))
            return yield* Effect.fail(
              new EventQueueDeliveryError(asDeliveryCause(result)),
            );
          if (Option.isNone(result.value))
            return yield* Effect.fail(
              new EventQueueDeliveryError(
                new EventQueueSendTimeoutError(sendTimeoutMs),
              ),
            );
          if (Option.isSome(settled)) return yield* Effect.fail(settled.value);
        });
      },
      close() {
        return Effect.gen(function* () {
          yield* Effect.sync(admission.seal);
          const outcome = yield* Effect.result(
            state.idle.await.pipe(
              Effect.timeoutOption(`${sendTimeoutMs} millis`),
            ),
          );
          if (outcome._tag === "Failure" || Option.isNone(outcome.success)) {
            yield* Effect.sync(admission.releaseStorage);
            if (outcome._tag === "Failure")
              return yield* Effect.fail(outcome.failure);
            return yield* Effect.fail(
              new EventQueueDeliveryError(
                new EventQueueSendTimeoutError(sendTimeoutMs),
              ),
            );
          }
          Queue.offerUnsafe(messages, STOP);
          yield* Queue.shutdown(messages);
          const failure = errorFromFailure(state.failure);
          if (failure !== undefined) return yield* Effect.fail(failure);
        });
      },
      snapshotPressure() {
        return {
          maxPendingBytes: options.maxPendingBytes,
          pendingBytesPeak: state.pendingBytesPeak,
          capacityWaitsTotal: state.capacityWaitsTotal,
          overflowsTotal: state.overflowsTotal,
        };
      },
    };

    yield* Effect.addFinalizer(() => queue.close().pipe(Effect.ignore));
    return queue;
  });
}
