import type { SeqlaneDisplayValue } from "@seqlane/core";
import type {
  InteractionRequestedEvent,
  InteractionResponseEvent,
  InteractionResolvedEvent,
} from "./validation.js";

type WithoutMetadata<T> = T extends { readonly metadata: unknown }
  ? Omit<T, "metadata">
  : never;

/** Runtime interaction events before the runner adds canonical metadata. */
export type InteractionEventInput = WithoutMetadata<
  | InteractionRequestedEvent
  | InteractionResponseEvent
  | InteractionResolvedEvent
>;

export type {
  InteractionRequestedEvent,
  InteractionResponseEvent,
  InteractionResolvedEvent,
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
