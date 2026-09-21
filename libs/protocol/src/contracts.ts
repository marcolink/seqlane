import type { SeqlaneDisplayValue } from "@seqlane/core";

export type {
  InvocationCancelledEvent,
  InvocationCreatedEvent,
  InvocationFailedEvent,
  InvocationInputEvent,
  InvocationOutputEvent,
  InvocationActivityEvent,
  InvocationObservationEvent,
  SeqlaneObservation,
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

export interface SerializeSeqlaneErrorOptions {
  readonly validationEvidence?: SeqlaneDisplayValue;
}
