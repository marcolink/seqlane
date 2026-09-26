import { randomUUID } from "node:crypto";
import {
  encodeSeqlaneExecutionEvent,
  isJsonValue,
  serializeSeqlaneError,
  seqlaneExecutionEventSchema,
  type SeqlaneExecutionEvent,
  type SeqlaneExecutionEventMetadata,
  type InvocationObservationEvent,
  type SeqlanePlanSnapshot,
} from "@seqlane/protocol";
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

export interface ExecutionEventBridge extends SeqlaneEventSink {
  emitPlan(plan: SeqlanePlanSnapshot, workId: string, runId: string): void;
  emitObservation(event: Omit<InvocationObservationEvent, "metadata">): void;
  flush(): Promise<void>;
  /** Wait for accepted sends even when delivery has failed. */
  settle(): Promise<Error | undefined>;
  /** Send a terminal outcome after settling, outside a failed event queue. */
  sendTerminal(
    event: Extract<SeqlaneEvent, { type: "run.failed" | "run.cancelled" }>,
  ): Promise<void>;
}

export interface ExecutionEventBridgeOptions {
  readonly skipRunStarted?: boolean;
  readonly createEventId?: () => string;
  readonly clock?: () => Date;
  /** Maximum serialized bytes queued or being sent for one run. */
  readonly maxPendingBytes?: number;
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
  private lastDeliveredSequence = 0;

  constructor(
    private readonly send: SendExecutionEvent,
    private readonly maxPendingBytes: number,
  ) {
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
      throw new RangeError("maxPendingBytes must be a positive safe integer");
    }
  }

  enqueue(event: SeqlaneExecutionEvent): void {
    if (this.failure !== undefined) throw this.failure;

    const eventBytes = Buffer.byteLength(
      encodeSeqlaneExecutionEvent(event),
      "utf8",
    );
    if (this.pendingBytes + eventBytes > this.maxPendingBytes) {
      this.failure = new ExecutionEventQueueOverflowError(this.maxPendingBytes);
      throw this.failure;
    }

    this.pendingBytes += eventBytes;
    this.pending = this.pending.then(async () => {
      try {
        if (this.transportFailed) return;
        await this.send(event);
        this.lastDeliveredSequence = event.metadata.sequence;
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

  nextDeliverySequence(): number {
    return this.lastDeliveredSequence + 1;
  }
}

function toExecutionEvent(
  event: SeqlaneEvent,
  metadata: SeqlaneExecutionEventMetadata,
): SeqlaneExecutionEvent {
  const serializeError = (
    error: SeqlaneError,
  ): ReturnType<typeof serializeSeqlaneError> =>
    error instanceof ValidationFailedError
      ? serializeSeqlaneError(
          error,
          error.evidence === undefined
            ? {}
            : {
                validationEvidence: toSeqlaneDisplayValue(error.evidence),
              },
        )
      : serializeSeqlaneError(error);

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
      return { ...event, metadata, error: serializeError(event.error) };
    case "run.succeeded":
      if (!isJsonValue(event.output)) {
        throw new TypeError("Seqlane run output must be JSON serializable");
      }
      return { ...event, metadata, output: event.output };
    case "run.failed":
      return { ...event, metadata, error: serializeError(event.error) };
  }
}

function createMetadata(
  sequence: number,
  createEventId: () => string,
  clock: () => Date,
): SeqlaneExecutionEventMetadata {
  return {
    schemaVersion: 1,
    eventId: createEventId(),
    sequence,
    occurredAt: clock().toISOString(),
  };
}

export function createExecutionEventBridge(
  send: SendExecutionEvent,
  options: ExecutionEventBridgeOptions = {},
): ExecutionEventBridge {
  let sequence = 0;
  const createEventId = options.createEventId ?? randomUUID;
  const clock = options.clock ?? (() => new Date());
  const queue = new BoundedExecutionEventQueue(
    send,
    options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
  );

  return {
    emitPlan(plan, workId, runId) {
      const nextSequence = sequence + 1;
      const event: SeqlaneExecutionEvent = {
        type: "run.plan",
        metadata: createMetadata(nextSequence, createEventId, clock),
        workId,
        runId,
        plan,
      };
      queue.enqueue(event);
      sequence = nextSequence;
    },
    emit(event) {
      if (options.skipRunStarted && event.type === "run.started") return;
      const nextSequence = sequence + 1;
      const canonical = toExecutionEvent(
        event,
        createMetadata(nextSequence, createEventId, clock),
      );
      queue.enqueue(canonical);
      sequence = nextSequence;
    },
    emitObservation(event) {
      const nextSequence = sequence + 1;
      const canonical = {
        ...event,
        metadata: createMetadata(nextSequence, createEventId, clock),
      };
      const parsed = seqlaneExecutionEventSchema.safeParse(canonical);
      if (!parsed.success) {
        throw new TypeError("Invalid invocation observation event");
      }
      queue.enqueue(parsed.data);
      sequence = nextSequence;
    },
    flush: () => queue.flush(),
    settle: () => queue.settle(),
    sendTerminal: (event) =>
      send(
        toExecutionEvent(
          event,
          createMetadata(queue.nextDeliverySequence(), createEventId, clock),
        ),
      ),
  };
}
