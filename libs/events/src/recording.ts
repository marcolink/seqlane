import {
  decodeSeqlaneExecutionEvent,
  encodeSeqlaneExecutionEvent,
} from "./serialization.js";
import type { SeqlaneExecutionEvent } from "./contracts.js";
import { z } from "zod";

export const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
export const MAX_RECORDING_EVENTS = 10_000;
const MAX_WORKFLOW_ID_LENGTH = 256;

const recordingHeaderSchema = z.strictObject({
  type: z.literal("seqlane.recording"),
  version: z.literal(1),
  workflowId: z.string().min(1).max(MAX_WORKFLOW_ID_LENGTH),
});

export interface SeqlaneRecordingHeader {
  readonly type: "seqlane.recording";
  readonly version: 1;
  readonly workflowId: string;
}

export interface SeqlaneRecording {
  readonly header: SeqlaneRecordingHeader;
  readonly events: readonly SeqlaneExecutionEvent[];
}

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

export function encodeRecordingEvent(event: SeqlaneExecutionEvent): string {
  return encodeSeqlaneExecutionEvent(event) + "\n";
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
): SeqlaneExecutionEvent {
  try {
    return decodeSeqlaneExecutionEvent(line.replace(/\r$/, ""));
  } catch {
    throw new Error(`Invalid recording event JSON at line ${lineNumber}`);
  }
}

export interface RecordingEventValidator {
  validate(event: SeqlaneExecutionEvent): () => void;
}

export function createRecordingEventValidator(): RecordingEventValidator {
  let lastSequence = 0;
  let workId: string | undefined;
  let runId: string | undefined;
  const eventIds = new Set<string>();

  return {
    validate(event) {
      if (event.metadata.sequence !== lastSequence + 1) {
        throw new Error("Recording event sequence is missing or out of order");
      }
      if (eventIds.has(event.metadata.eventId)) {
        throw new Error("Recording event identity is duplicated");
      }
      if (workId === undefined) {
        workId = event.workId;
        runId = event.runId;
        if (event.type !== "run.started") {
          throw new Error("Recording must start with run.started");
        }
      } else if (event.workId !== workId || event.runId !== runId) {
        throw new Error("Recording event identity does not match the run");
      }
      return () => {
        lastSequence = event.metadata.sequence;
        eventIds.add(event.metadata.eventId);
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

  const events: SeqlaneExecutionEvent[] = [];
  const eventValidator = createRecordingEventValidator();
  for (const [index, line] of lines.slice(1).entries()) {
    const event = parseRecordingEvent(line, index + 2);
    const commitEvent = eventValidator.validate(event);
    events.push(event);
    commitEvent();
  }
  if (events.length === 0) throw new Error("Recording contains no events");
  return { header, events };
}
