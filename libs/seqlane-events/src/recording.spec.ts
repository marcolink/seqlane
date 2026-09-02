// @test-scope ./recording.ts

import {
  decodeSeqlaneRecording,
  encodeRecordingEvent,
  type SeqlaneExecutionEvent,
} from "./index.js";
import { describe, expect, it } from "vitest";

function started(sequence = 1): SeqlaneExecutionEvent {
  return {
    type: "run.started",
    metadata: {
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: "2026-08-22T12:00:00.000Z",
    },
    workId: "work-1",
    runId: "run-1",
  };
}

function recordingText(events: readonly SeqlaneExecutionEvent[]): string {
  return `${JSON.stringify({
    type: "seqlane.recording",
    version: 1,
    workflowId: "workflow-1",
  })}\n${events.map(encodeRecordingEvent).join("")}`;
}

describe("Seqlane recording format", () => {
  it("decodes a bounded header and canonical event stream", () => {
    expect(decodeSeqlaneRecording(recordingText([started()]))).toEqual({
      header: {
        type: "seqlane.recording",
        version: 1,
        workflowId: "workflow-1",
      },
      events: [started()],
    });
  });

  it.each([
    ["invalid header JSON", "{\n", /header JSON/i],
    [
      "invalid event JSON",
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\nnot-json\n`,
      /event JSON/i,
    ],
    [
      "empty interior line",
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\n\n${encodeRecordingEvent(started())}`,
      /empty line/i,
    ],
  ])("rejects %s", (_name, value, message) => {
    expect(() => decodeSeqlaneRecording(value)).toThrow(message);
  });

  it("rejects a recording without events", () => {
    const header = JSON.stringify({
      type: "seqlane.recording",
      version: 1,
      workflowId: "workflow-1",
    });
    expect(() => decodeSeqlaneRecording(`${header}\n`)).toThrow(/no events/i);
  });
});
