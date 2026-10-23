import { randomUUID } from "node:crypto";
import {
  isJsonValue,
  serializeSeqlaneError,
  seqlaneExecutionEventSchema,
  type SeqlaneExecutionEvent,
  type SeqlaneExecutionEventMetadata,
  type InvocationObservationEvent,
  type SeqlanePlanSnapshot,
} from "@seqlane/protocol";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import { Effect, Exit, Option, Semaphore } from "effect";
import type { ByteBoundedEventQueue } from "./byte-bounded-event-queue.js";
import {
  ValidationFailedError,
  type SeqlaneError,
  type SeqlaneEvent,
  type SeqlaneEventSink,
} from "@seqlane/core";
import { toSeqlaneDisplayValue } from "../runtime/execution/display-value.js";

export type SendExecutionEvent = (
  event: SeqlaneExecutionEvent,
) => Promise<void>;

type ExecutionBridgeEvent =
  | Exclude<SeqlaneEvent, { type: "run.failed" }>
  | (Extract<SeqlaneEvent, { type: "run.failed" }> &
      Pick<Extract<SeqlaneExecutionEvent, { type: "run.failed" }>, "phase">);

export interface ExecutionEventBridge extends SeqlaneEventSink {
  emit(event: ExecutionBridgeEvent): void;
  emitPlan(plan: SeqlanePlanSnapshot, workId: string, runId: string): void;
  emitPlanEffect(
    plan: SeqlanePlanSnapshot,
    workId: string,
    runId: string,
  ): Effect.Effect<void, Error>;
  emitObservation(event: Omit<InvocationObservationEvent, "metadata">): void;
  emitAsync(event: SeqlaneEvent): Promise<void>;
  /** Native runtime producers use this Effect seam to wait for byte capacity. */
  emitEffect(event: ExecutionBridgeEvent): Effect.Effect<void, Error>;
  flush(): Promise<void>;
  /** Wait for accepted sends even when delivery has failed. */
  settle(): Promise<Error | undefined>;
  /** Send a terminal outcome after settling, outside a failed event queue. */
  sendTerminal(
    event: Extract<SeqlaneEvent, { type: "run.failed" | "run.cancelled" }>,
  ): Promise<void>;
  flushDeferredTerminal(): Promise<void>;
}

export interface ExecutionEventBridgeOptions {
  readonly skipRunStarted?: boolean;
  readonly createEventId?: () => string;
  readonly clock?: () => Date;
  readonly traceCarrier?: TraceCarrier;
  /** Maximum serialized bytes queued or being sent for one run. */
  readonly maxPendingBytes?: number;
  readonly queue?: ByteBoundedEventQueue;
  readonly lastAcknowledgedSequence?: () => number;
  readonly deferTerminalUntilTelemetry?: boolean;
  /** Shared only with the private worker sender so IPC reuses admitted bytes. */
  readonly encodedEvents?: WeakMap<SeqlaneExecutionEvent, string>;
}

const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;

class ExecutionEventQueueOverflowError extends Error {
  constructor(maxPendingBytes: number) {
    super(`Execution event queue exceeded ${maxPendingBytes} bytes`);
    this.name = "ExecutionEventQueueOverflowError";
  }
}

class BoundedExecutionEventQueue {
  private pending = Promise.resolve();
  private pendingBytes = 0;
  private failure: Error | undefined;
  private transportFailed = false;
  private lastAcknowledgedSequence = 0;

  constructor(
    private readonly send: SendExecutionEvent,
    private readonly maxPendingBytes: number,
  ) {
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
      throw new RangeError("maxPendingBytes must be a positive safe integer");
    }
  }

  enqueue(
    event: SeqlaneExecutionEvent,
    eventBytes: number,
    onAdmitted: () => void,
  ): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.pendingBytes + eventBytes > this.maxPendingBytes) {
      this.failure = new ExecutionEventQueueOverflowError(this.maxPendingBytes);
      throw this.failure;
    }

    this.pendingBytes += eventBytes;
    onAdmitted();
    this.pending = this.pending.then(async () => {
      try {
        if (this.transportFailed) return;
        await this.send(event);
        this.lastAcknowledgedSequence = event.metadata.sequence;
      } catch (cause) {
        this.transportFailed = true;
        this.failure ??=
          cause instanceof Error ? cause : new Error("Event delivery failed");
      } finally {
        this.pendingBytes -= eventBytes;
      }
    });
  }

  async settle(): Promise<Error | undefined> {
    await this.pending;
    return this.failure;
  }

  async flush(): Promise<void> {
    const failure = await this.settle();
    if (failure !== undefined) throw failure;
  }

  acknowledgedSequence(): number {
    return this.lastAcknowledgedSequence;
  }
}

export class NonSerializableRunOutputError extends TypeError {
  constructor() {
    super("Seqlane run output must be JSON serializable");
  }
}

function serializeExecutionError(
  error: SeqlaneError,
): ReturnType<typeof serializeSeqlaneError> {
  return error instanceof ValidationFailedError
    ? serializeSeqlaneError(
        error,
        error.evidence === undefined
          ? {}
          : {
              validationEvidence: toSeqlaneDisplayValue(error.evidence),
            },
      )
    : serializeSeqlaneError(error);
}

function toExecutionEvent(
  event: ExecutionBridgeEvent,
  metadata: SeqlaneExecutionEventMetadata,
): SeqlaneExecutionEvent {
  switch (event.type) {
    case "run.started":
    case "invocation.created":
    case "invocation.progress":
    case "invocation.output":
    case "invocation.activity":
    case "invocation.input":
    case "invocation.result":
    case "invocation.succeeded":
    case "invocation.skipped":
    case "invocation.cancelled":
    case "run.heartbeat":
    case "invocation.started":
    case "run.cancelled":
      return { ...event, metadata } as SeqlaneExecutionEvent;
    case "invocation.retrying":
      return {
        ...event,
        metadata,
        lastError: serializeSeqlaneError(event.lastError),
      };
    case "invocation.failed":
      return {
        ...event,
        metadata,
        error: serializeExecutionError(event.error),
      };
    case "run.succeeded":
      if (!isJsonValue(event.output)) {
        throw new NonSerializableRunOutputError();
      }
      return { ...event, metadata, output: event.output };
    case "run.failed":
      return {
        ...event,
        metadata,
        error: serializeExecutionError(event.error),
        ...(event.error.cause instanceof NonSerializableRunOutputError
          ? { phase: "result-serialization" as const }
          : {}),
      };
  }
}

function createMetadata(
  sequence: number,
  createEventId: () => string,
  clock: () => Date,
  traceCarrier?: TraceCarrier,
): SeqlaneExecutionEventMetadata {
  return {
    schemaVersion: 1,
    eventId: createEventId(),
    sequence,
    occurredAt: clock().toISOString(),
    ...(traceCarrier === undefined ? {} : traceCarrier),
  };
}

function errorFromCause(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("Execution event enqueue failed", { cause });
}

export function createExecutionEventBridge(
  send: SendExecutionEvent,
  options: ExecutionEventBridgeOptions = {},
): ExecutionEventBridge {
  let sequence = 0;
  let pendingNativeSequence: number | undefined;
  const sequenceAdmission = Semaphore.makeUnsafe(1);
  let deferredTerminal: SeqlaneExecutionEvent | undefined;
  const createEventId = options.createEventId ?? randomUUID;
  const clock = options.clock ?? (() => new Date());
  const queue = new BoundedExecutionEventQueue(
    send,
    options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
  );
  const encodeAccepted = (
    event: SeqlaneExecutionEvent,
  ): { event: SeqlaneExecutionEvent; encoded: string } => {
    const parsed = seqlaneExecutionEventSchema.parse(event);
    const accepted = structuredClone(parsed);
    let encoded: string;
    try {
      encoded = JSON.stringify(accepted);
      if (encoded === undefined) throw new TypeError();
    } catch {
      throw new TypeError("Invalid Seqlane execution event");
    }
    options.encodedEvents?.set(accepted, encoded);
    return { event: accepted, encoded };
  };
  const assertNoPendingAdmission = (): void => {
    if (pendingNativeSequence !== undefined) {
      const failure = new Error(
        "A native event is waiting for canonical admission",
      );
      options.queue?.reportFailure(failure);
      throw failure;
    }
  };
  const commitAdmission = (acceptedSequence: number): void => {
    sequence = acceptedSequence;
    if (pendingNativeSequence === acceptedSequence) {
      pendingNativeSequence = undefined;
    }
  };
  const enqueue = (
    event: SeqlaneExecutionEvent,
    onAdmitted: () => void,
  ): void => {
    const accepted = encodeAccepted(event);
    if (options.queue !== undefined) {
      options.queue.offerCallback(
        accepted.event,
        Buffer.byteLength(accepted.encoded, "utf8"),
        onAdmitted,
      );
    } else {
      queue.enqueue(
        accepted.event,
        Buffer.byteLength(accepted.encoded, "utf8"),
        onAdmitted,
      );
    }
  };
  const enqueueEffect = (
    event: SeqlaneExecutionEvent,
    onAdmitted: () => void,
  ): Effect.Effect<void, Error> => {
    const accepted = encodeAccepted(event);
    if (options.queue === undefined) {
      return Effect.try({
        try: () =>
          queue.enqueue(
            accepted.event,
            Buffer.byteLength(accepted.encoded, "utf8"),
            onAdmitted,
          ),
        catch: errorFromCause,
      });
    }
    return options.queue.offer(
      accepted.event,
      Buffer.byteLength(accepted.encoded, "utf8"),
      onAdmitted,
    );
  };

  return {
    emitPlan(plan, workId, runId) {
      assertNoPendingAdmission();
      const nextSequence = sequence + 1;
      const event: SeqlaneExecutionEvent = {
        type: "run.plan",
        metadata: createMetadata(
          nextSequence,
          createEventId,
          clock,
          options.traceCarrier,
        ),
        workId,
        runId,
        plan,
      };
      enqueue(event, () => commitAdmission(nextSequence));
    },
    emitPlanEffect(plan, workId, runId) {
      return sequenceAdmission.withPermits(1)(
        Effect.suspend(() => {
          const nextSequence = sequence + 1;
          const event: SeqlaneExecutionEvent = {
            type: "run.plan",
            metadata: createMetadata(
              nextSequence,
              createEventId,
              clock,
              options.traceCarrier,
            ),
            workId,
            runId,
            plan,
          };
          pendingNativeSequence = nextSequence;
          const admission = Effect.suspend(() =>
            enqueueEffect(event, () => commitAdmission(nextSequence)),
          );
          return admission.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (
                  Exit.isFailure(exit) &&
                  pendingNativeSequence === nextSequence
                ) {
                  pendingNativeSequence = undefined;
                }
              }),
            ),
          );
        }),
      );
    },
    emit(event) {
      if (options.skipRunStarted && event.type === "run.started") return;
      assertNoPendingAdmission();
      const nextSequence = sequence + 1;
      const canonical = toExecutionEvent(
        event,
        createMetadata(
          nextSequence,
          createEventId,
          clock,
          options.traceCarrier,
        ),
      );
      if (
        options.deferTerminalUntilTelemetry &&
        (canonical.type === "run.succeeded" ||
          canonical.type === "run.cancelled" ||
          canonical.type === "run.failed")
      ) {
        deferredTerminal = canonical;
        commitAdmission(nextSequence);
        return;
      }
      enqueue(canonical, () => commitAdmission(nextSequence));
    },
    emitObservation(event) {
      assertNoPendingAdmission();
      const nextSequence = sequence + 1;
      const canonical = {
        ...event,
        metadata: createMetadata(
          nextSequence,
          createEventId,
          clock,
          options.traceCarrier,
        ),
      };
      enqueue(canonical, () => commitAdmission(nextSequence));
    },
    emitEffect(event) {
      if (options.skipRunStarted && event.type === "run.started")
        return Effect.void;
      return sequenceAdmission.withPermits(1)(
        Effect.suspend(() => {
          const nextSequence = sequence + 1;
          const canonical = toExecutionEvent(
            event,
            createMetadata(
              nextSequence,
              createEventId,
              clock,
              options.traceCarrier,
            ),
          );
          if (
            options.deferTerminalUntilTelemetry &&
            (canonical.type === "run.succeeded" ||
              canonical.type === "run.cancelled" ||
              canonical.type === "run.failed")
          ) {
            deferredTerminal = canonical;
            commitAdmission(nextSequence);
            return Effect.void;
          }
          pendingNativeSequence = nextSequence;
          const admission = Effect.suspend(() =>
            enqueueEffect(canonical, () => commitAdmission(nextSequence)),
          );
          return admission.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (
                  Exit.isFailure(exit) &&
                  pendingNativeSequence === nextSequence
                ) {
                  pendingNativeSequence = undefined;
                }
              }),
            ),
          );
        }),
      );
    },
    emitAsync(event) {
      return Effect.runPromise(this.emitEffect(event));
    },
    flush: () =>
      options.queue === undefined
        ? queue.flush()
        : Effect.runPromise(options.queue.flush()),
    settle: async () => {
      if (options.queue === undefined) return queue.settle();
      const result = await Effect.runPromise(options.queue.settle());
      return Option.isSome(result) ? result.value : undefined;
    },
    sendTerminal: (event) => {
      const canonical = toExecutionEvent(
        event,
        createMetadata(
          (options.lastAcknowledgedSequence?.() ??
            queue.acknowledgedSequence()) + 1,
          createEventId,
          clock,
          options.traceCarrier,
        ),
      );
      if (options.deferTerminalUntilTelemetry) {
        deferredTerminal = canonical;
        return Promise.resolve();
      }
      return options.queue === undefined
        ? send(canonical)
        : Effect.runPromise(options.queue.sendTerminal(canonical));
    },
    flushDeferredTerminal: async () => {
      const terminal = deferredTerminal;
      deferredTerminal = undefined;
      if (terminal === undefined) return;
      const accepted = encodeAccepted(terminal);
      if (options.queue === undefined) {
        await send(accepted.event);
      } else if (terminal.type === "run.succeeded") {
        await Effect.runPromise(
          options.queue.offer(
            accepted.event,
            Buffer.byteLength(accepted.encoded, "utf8"),
          ),
        );
        await Effect.runPromise(options.queue.flush());
      } else {
        await Effect.runPromise(options.queue.sendTerminal(accepted.event));
      }
    },
  };
}
