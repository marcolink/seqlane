import type { InvocationObservationEvent } from "@seqlane/protocol";

export function modelObservationIdentity(
  event: InvocationObservationEvent,
): string {
  const provider = event.model.provider ?? "unknown-provider";
  const model = event.model.model ?? "unknown-model";
  return `${provider}/${model}`;
}

export function formatModelObservationSummary(
  event: InvocationObservationEvent,
): string {
  const response =
    event.model.response === undefined ? "" : " response=present";
  const request = event.model.request === undefined ? "" : " request=present";
  return `model ${modelObservationIdentity(event)} state=${event.state} attempt=${event.attemptIndex ?? 0}${request}${response}`;
}
