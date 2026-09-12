import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/core";
import {
  createRecordingConsumer,
  MAX_RECORDING_BYTES,
  readSeqlaneRecording,
} from "./recording.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function recordingPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "seqlane-recording-"));
  directories.push(directory);
  return join(directory, "run.jsonl");
}

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

function plan(sequence = 2): SeqlaneExecutionEvent {
  return {
    type: "run.plan",
    metadata: {
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: "2026-08-22T12:00:00.001Z",
    },
    workId: "work-1",
    runId: "run-1",
    plan: {
      workflow: { id: "workflow-1", version: "1" },
      nodes: [
        {
          planNodeId: "task:one",
          type: "task",
          label: "One",
          taskId: "one",
          dependsOn: [],
          siblingOrder: 0,
        },
      ],
    },
  };
}

describe("Seqlane recording", () => {
  function writeRecording(
    path: string,
    events: readonly SeqlaneExecutionEvent[],
  ): void {
    writeFileSync(
      path,
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\n${events.map(encodeSeqlaneExecutionEvent).join("\n")}\n`,
    );
  }

  it("round-trips the generic header and canonical events", async () => {
    const path = recordingPath();
    const consumer = createRecordingConsumer(path, "workflow-1");
    consumer.consume(started());
    consumer.consume(plan());
    await consumer.flush();
    await consumer.close();

    const recording = readSeqlaneRecording(path);

    expect(recording.header).toEqual({
      type: "seqlane.recording",
      version: 1,
      workflowId: "workflow-1",
    });
    expect(recording.events).toEqual([started(), plan()]);
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(4);
  });

  it("creates a new recording and never silently overwrites", async () => {
    const path = recordingPath();
    const first = createRecordingConsumer(path, "workflow-1");
    expect(existsSync(path)).toBe(true);
    expect(() => createRecordingConsumer(path, "workflow-1")).toThrow(
      /already exists|EEXIST/i,
    );
    await first.close();
  });

  it("rejects recordings that exceed event or byte bounds", async () => {
    const eventBoundPath = recordingPath();
    const eventBound = createRecordingConsumer(eventBoundPath, "workflow-1", {
      maxEvents: 1,
    });
    eventBound.consume(started());
    expect(() => eventBound.consume(plan())).toThrow(/event limit/i);
    await eventBound.close();

    const byteBoundPath = recordingPath();
    const byteBound = createRecordingConsumer(byteBoundPath, "workflow-1", {
      maxBytes: 100,
    });
    expect(() => byteBound.consume(started())).toThrow(/byte limit/i);
    await byteBound.close();
  });

  it("rejects malformed JSON, malformed headers, and invalid canonical events", () => {
    const malformedJson = recordingPath();
    writeFileSync(malformedJson, "{\n");
    expect(() => readSeqlaneRecording(malformedJson)).toThrow(/header JSON/i);

    const malformedHeader = recordingPath();
    writeFileSync(
      malformedHeader,
      `${JSON.stringify({ type: "wrong", version: 1, workflowId: "workflow-1" })}\n`,
    );
    expect(() => readSeqlaneRecording(malformedHeader)).toThrow(
      /invalid recording header/i,
    );

    const malformedEvent = recordingPath();
    writeFileSync(
      malformedEvent,
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\nnot-json\n`,
    );
    expect(() => readSeqlaneRecording(malformedEvent)).toThrow(/event JSON/i);

    const oversized = recordingPath();
    writeFileSync(oversized, Buffer.alloc(MAX_RECORDING_BYTES + 1));
    expect(() => readSeqlaneRecording(oversized)).toThrow(/byte limit/i);
  });

  it("rejects missing, duplicate, out-of-order, and mixed run identities", () => {
    const cases: [string, SeqlaneExecutionEvent[]][] = [
      ["missing sequence", [started(1), plan(3)]],
      ["duplicate sequence", [started(1), plan(1)]],
      ["out of order", [started(2), plan(3)]],
      [
        "wrong run identity",
        [
          started(1),
          {
            ...plan(),
            workId: "work-2",
          },
        ],
      ],
    ];

    for (const [name, events] of cases) {
      const path = recordingPath();
      writeRecording(path, events);
      expect(() => readSeqlaneRecording(path)).toThrow(
        name === "wrong run identity" ? /identity/i : /sequence/i,
      );
    }
  });

  it("reads a run.started plus run.plan prefix without execution", async () => {
    const path = recordingPath();
    const writer = createRecordingConsumer(path, "workflow-1");
    writer.consume(started());
    writer.consume(plan());
    await writer.close();

    const received: string[] = [];
    const recording = readSeqlaneRecording(path);
    for (const event of recording.events) received.push(event.type);

    expect(received).toEqual(["run.started", "run.plan"]);
    expect(recording.events[1]).toMatchObject({
      type: "run.plan",
      plan: { nodes: [{ planNodeId: "task:one" }] },
    });
  });
});
