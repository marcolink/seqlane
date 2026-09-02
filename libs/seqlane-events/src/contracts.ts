import type { SeqlaneDisplayValue } from "@seqlane/core";
import type { SeqlaneExecutionEvent as SeqlaneEvent } from "./validation.js";

export type {
  InvocationCancelledEvent,
  InvocationCreatedEvent,
  InvocationFailedEvent,
  InvocationInputEvent,
  InvocationOutputEvent,
  InvocationActivityEvent,
  InvocationProgressEvent,
  InvocationResultEvent,
  InvocationRetryingEvent,
  InvocationSkippedEvent,
  InvocationStartedEvent,
  InvocationSucceededEvent,
  RunCancelledEvent,
  RunFailedEvent,
  RunHeartbeatEvent,
  RunPlanEvent,
  RunStartedEvent,
  RunSucceededEvent,
  SerializedSeqlaneError,
  SerializedValidationFailure,
  SeqlaneExecutionEvent,
  SeqlaneExecutionEventMetadata,
  SeqlanePlanNodeSnapshot,
  SeqlanePlanSnapshot,
} from "./validation.js";

export interface SeqlaneExecutionEventConsumer {
  consume(event: SeqlaneEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SerializeSeqlaneErrorOptions {
  readonly validationEvidence?: SeqlaneDisplayValue;
}
