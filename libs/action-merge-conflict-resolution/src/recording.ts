import type { SeqlaneEvent } from "@seqlane/core";

export const MAX_RECORDING_EVENTS = 128;
export const MAX_RECORDING_BYTES = 64 * 1024;
export const REDACTED_VALUE = "[REDACTED]";

export interface BoundedRecording {
  readonly events: readonly SeqlaneEvent[];
  readonly truncated: boolean;
  record(event: SeqlaneEvent): void;
}

type RecordingSecrets = string | readonly string[] | undefined;

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (redacted, secret) => redacted.split(secret).join(REDACTED_VALUE),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
  );
}

export function createBoundedRecording(
  secret: RecordingSecrets = process.env.OPENAI_API_KEY,
  maximumEvents = MAX_RECORDING_EVENTS,
  maximumBytes = MAX_RECORDING_BYTES,
): BoundedRecording {
  const secrets = [
    ...new Set(
      (typeof secret === "string" ? [secret] : (secret ?? [])).filter(
        (value) => value.length > 0,
      ),
    ),
  ].sort((first, second) => second.length - first.length);
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
      const redacted = redact(event, secrets) as SeqlaneEvent;
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

export function formatBoundedRecording(recording: BoundedRecording): string {
  const lines = ["Agent recording:"];
  lines.push(...recording.events.map((event) => JSON.stringify(event)));
  if (recording.truncated) lines.push("Agent recording truncated: true");
  return lines.join("\n");
}
