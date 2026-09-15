import {
  encodeSeqlaneExecutionEvent,
  seqlaneExecutionEventSchema,
} from "@seqlane/protocol";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { z } from "zod";

export const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
export const MAX_RECORDING_EVENTS = 10_000;
const MAX_WORKFLOW_ID_LENGTH = 256;

export const recordingHeaderSchema = z.strictObject({
  type: z.literal("seqlane.recording"),
  version: z.literal(1),
  workflowId: z.string().min(1).max(MAX_WORKFLOW_ID_LENGTH),
});

const positiveSafeIntegerSchema = z.number().int().positive().safe();

/** Canonical options for bounded recording writes. */
export const recordingOptionsSchema = z.strictObject({
  maxBytes: positiveSafeIntegerSchema.optional(),
  maxEvents: positiveSafeIntegerSchema.optional(),
});

export const seqlaneRecordingSchema = z.strictObject({
  header: recordingHeaderSchema,
  events: z.array(seqlaneExecutionEventSchema).readonly(),
});

export type SeqlaneRecordingHeader = z.output<typeof recordingHeaderSchema>;
/** Readonly producer input; schema parsing below normalizes it for encoding. */
export type RecordingEventInput = SeqlaneExecutionEvent;
export type RecordingOptions = z.output<typeof recordingOptionsSchema>;
export type RecordingEvent = z.output<typeof seqlaneExecutionEventSchema>;

export type SeqlaneRecording = z.output<typeof seqlaneRecordingSchema>;

export function createRecordingHeader(
  workflowId: string,
): SeqlaneRecordingHeader {
  const result = recordingHeaderSchema.safeParse({
    type: "seqlane.recording",
    version: 1,
    workflowId,
  });
  if (!result.success) {
    throw new Error("Recording workflowId must be 1-256 characters");
  }
  return result.data;
}

export function encodeRecordingHeader(header: SeqlaneRecordingHeader): string {
  return JSON.stringify(header) + "\n";
}

export function encodeRecordingEvent(event: RecordingEventInput): string {
  // Parse at the schema boundary so readonly producer events are accepted
  // without mutating them or relying on an unsafe cast.
  const parsed = seqlaneExecutionEventSchema.parse(event);
  return encodeSeqlaneExecutionEvent(parsed) + "\n";
}

function parseJson(line: string, label: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Invalid recording ${label} JSON`);
  }
}

export function parseRecordingHeader(line: string): SeqlaneRecordingHeader {
  const result = recordingHeaderSchema.safeParse(parseJson(line, "header"));
  if (!result.success) throw new Error("Invalid recording header");
  return result.data;
}

export function parseRecordingEvent(
  line: string,
  lineNumber: number,
): RecordingEvent {
  try {
    const result = seqlaneExecutionEventSchema.safeParse(
      parseJson(line.replace(/\r$/, ""), "event"),
    );
    if (result.success) return result.data;
  } catch {
    // Normalize JSON parser and schema failures below with record context.
  }
  throw new Error(
    `Invalid recording event JSON at record ${lineNumber - 1} (line ${lineNumber})`,
  );
}

export interface RecordingEventValidator {
  validate(event: RecordingEventInput): () => void;
}

export function createRecordingEventValidator(): RecordingEventValidator {
  let lastSequence = 0;
  let workId: string | undefined;
  let runId: string | undefined;
  const eventIds = new Set<string>();

  return {
    validate(event: RecordingEventInput) {
      const parsed = seqlaneExecutionEventSchema.parse(event);
      if (parsed.metadata.sequence !== lastSequence + 1) {
        throw new Error("Recording event sequence is missing or out of order");
      }
      if (eventIds.has(parsed.metadata.eventId)) {
        throw new Error("Recording event identity is duplicated");
      }
      if (workId === undefined) {
        workId = parsed.workId;
        runId = parsed.runId;
        if (parsed.type !== "run.started") {
          throw new Error("Recording must start with run.started");
        }
      } else if (parsed.workId !== workId || parsed.runId !== runId) {
        throw new Error("Recording event identity does not match the run");
      }
      return () => {
        lastSequence = parsed.metadata.sequence;
        eventIds.add(parsed.metadata.eventId);
      };
    },
  };
}

export function decodeSeqlaneRecording(content: string): SeqlaneRecording {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("Recording contains an empty line");
  }

  const firstLine = lines[0];
  if (firstLine === undefined) throw new Error("Recording contains no header");
  const header = parseRecordingHeader(firstLine);
  if (lines.length - 1 > MAX_RECORDING_EVENTS) {
    throw new Error("Recording event limit exceeded");
  }

  const events: RecordingEvent[] = [];
  const eventValidator = createRecordingEventValidator();
  for (const [index, line] of lines.slice(1).entries()) {
    const event = parseRecordingEvent(line, index + 2);
    const commitEvent = eventValidator.validate(event);
    events.push(event);
    commitEvent();
  }
  if (events.length === 0) throw new Error("Recording contains no events");
  return seqlaneRecordingSchema.parse({ header, events });
}
