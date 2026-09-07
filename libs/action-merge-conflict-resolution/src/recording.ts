import type { SeqlaneEvent } from "@seqlane/core";

export const MAX_RECORDING_EVENTS = 128;
export const MAX_RECORDING_BYTES = 64 * 1024;
export const REDACTED_VALUE = "[REDACTED]";

export interface BoundedRecording {
  readonly events: readonly SeqlaneEvent[];
  readonly truncated: boolean;
  readonly redactText: (value: string) => string;
  record(event: SeqlaneEvent): void;
}

type RecordingSecrets = string | readonly string[] | undefined;

export interface SecretRedactor {
  readonly redactText: (value: string) => string;
  readonly redactValue: (value: unknown) => unknown;
}

export function createSecretRedactor(secret: RecordingSecrets): SecretRedactor {
  const secrets = [
    ...new Set(
      (typeof secret === "string" ? [secret] : (secret ?? [])).filter(
        (value) => value.length > 0,
      ),
    ),
  ].sort((first, second) => second.length - first.length);

  const redactText = (value: string): string =>
    secrets.reduce(
      (redacted, configuredSecret) =>
        redacted.split(configuredSecret).join(REDACTED_VALUE),
      value,
    );

  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map((item) => redactValue(item));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item)]),
    );
  };

  return { redactText, redactValue };
}

export function createBoundedRecording(
  secret: RecordingSecrets = process.env.OPENAI_API_KEY,
  maximumEvents = MAX_RECORDING_EVENTS,
  maximumBytes = MAX_RECORDING_BYTES,
): BoundedRecording {
  const redactor = createSecretRedactor(secret);
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
    redactText: redactor.redactText,
    record(event) {
      if (truncated || events.length >= maximumEvents) {
        truncated = true;
        return;
      }
      const redacted = redactor.redactValue(event) as SeqlaneEvent;
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
  return `Diagnostics: ${recording.events.length} bounded event(s); truncated: ${String(recording.truncated)}`;
}
