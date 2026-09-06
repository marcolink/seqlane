import type { SeqlaneEvent } from "@seqlane/core";

export const MAX_RECORDING_EVENTS = 128;
export const MAX_RECORDING_BYTES = 64 * 1024;
export const REDACTED_VALUE = "[REDACTED]";

export interface BoundedRecording {
  readonly events: readonly SeqlaneEvent[];
  readonly truncated: boolean;
  record(event: SeqlaneEvent): void;
}

function redact(value: unknown, secret: string | undefined): unknown {
  if (typeof value === "string") {
    if (secret !== undefined && secret.length > 0) {
      return value.split(secret).join(REDACTED_VALUE);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redact(item, secret)]),
  );
}

export function createBoundedRecording(
  secret = process.env.OPENAI_API_KEY,
  maximumEvents = MAX_RECORDING_EVENTS,
  maximumBytes = MAX_RECORDING_BYTES,
): BoundedRecording {
  const events: SeqlaneEvent[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    get events() {
      return events;
    },
    get truncated() {
      return truncated;
    },
    record(event) {
      if (truncated || events.length >= maximumEvents) {
        truncated = true;
        return;
      }
      const redacted = redact(event, secret) as SeqlaneEvent;
      const encoded = JSON.stringify(redacted);
      if (encoded === undefined || bytes + encoded.length > maximumBytes) {
        truncated = true;
        return;
      }
      bytes += encoded.length;
      events.push(redacted);
    },
  };
}
