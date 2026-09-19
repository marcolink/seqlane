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
  return `model ${modelObservationIdentity(event)}`;
}
