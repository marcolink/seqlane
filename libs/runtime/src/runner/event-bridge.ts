import { randomUUID } from "node:crypto";
import {
  isJsonValue,
  serializeSeqlaneError,
  type SeqlaneExecutionEvent,
  type SeqlaneExecutionEventMetadata,
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
  flush(): Promise<void>;
}

export interface ExecutionEventBridgeOptions {
  readonly skipRunStarted?: boolean;
  readonly createEventId?: () => string;
  readonly clock?: () => Date;
}

export class NonSerializableRunOutputError extends TypeError {
  constructor() {
    super("Seqlane run output must be JSON serializable");
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
                validationEvidence: toSeqlaneDisplayValue(
                  error.evidence,
                  undefined,
                ),
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
        throw new NonSerializableRunOutputError();
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
  let pending = Promise.resolve();
  let sequence = 0;
  const createEventId = options.createEventId ?? randomUUID;
  const clock = options.clock ?? (() => new Date());

  return {
    emitPlan(plan, workId, runId) {
      const event: SeqlaneExecutionEvent = {
        type: "run.plan",
        metadata: createMetadata(++sequence, createEventId, clock),
        workId,
        runId,
        plan,
      };
      pending = pending.then(() => send(event));
    },
    emit(event) {
      if (options.skipRunStarted && event.type === "run.started") return;
      const canonical = toExecutionEvent(
        event,
        createMetadata(++sequence, createEventId, clock),
      );
      pending = pending.then(() => send(canonical));
    },
    flush() {
      return pending;
    },
  };
}
