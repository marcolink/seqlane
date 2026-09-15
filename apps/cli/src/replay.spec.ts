// @test-scope ./replay.ts

import {
  encodeSeqlaneExecutionEvent,
  seqlaneExecutionEventSchema,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReplayEvents } from "./replay.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("replay event output", () => {
  it("redacts configured secrets before writing NDJSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-replay-"));
    directories.push(directory);
    const path = join(directory, "recording.jsonl");
    const started: SeqlaneExecutionEvent = {
      type: "run.started",
      metadata: {
        schemaVersion: 1,
        eventId: "event-0",
        sequence: 1,
        occurredAt: "2026-08-22T12:00:00.000Z",
      },
      workId: "work-1",
      runId: "run-1",
    };
    const event: SeqlaneExecutionEvent = {
      type: "invocation.output",
      metadata: {
        schemaVersion: 1 as const,
        eventId: "event-2",
        sequence: 2,
        occurredAt: "2026-08-22T12:00:00.000Z",
      },
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      policy: "persistent",
      channel: "task",
      content: "secret-work-id",
    };
    writeFileSync(
      path,
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\n${encodeSeqlaneExecutionEvent(started)}\n${encodeSeqlaneExecutionEvent(event)}\n`,
    );

    let output = "";
    writeReplayEvents(path, { write: (value) => (output += value) }, [
      "secret-work-id",
    ]);

    expect(output).not.toContain("secret-work-id");
    const lines = output.trimEnd().split("\n");
    expect(
      lines.every(
        (line) =>
          seqlaneExecutionEventSchema.safeParse(JSON.parse(line)).success,
      ),
    ).toBe(true);
    expect(JSON.parse(output.trimEnd().split("\n").at(-1) ?? "")).toMatchObject(
      {
        content: "***",
      },
    );
  });

  it("redacts dynamic values without changing identity, keys, or event order", () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-replay-"));
    directories.push(directory);
    const path = join(directory, "recording.jsonl");
    const started: SeqlaneExecutionEvent = {
      type: "run.started",
      metadata: {
        schemaVersion: 1,
        eventId: "event-0",
        sequence: 1,
        occurredAt: "2026-08-22T12:00:00.000Z",
      },
      workId: "runI-work-identity",
      runId: "runI-run-identity",
    };
    const event: SeqlaneExecutionEvent = {
      type: "invocation.output",
      metadata: {
        schemaVersion: 1,
        eventId: "event-2",
        sequence: 2,
        occurredAt: "2026-08-22T12:00:00.000Z",
      },
      workId: "runI-work-identity",
      runId: "runI-run-identity",
      invocationId: "invocation-1",
      policy: "persistent",
      channel: "task",
      content: 'before a"b-secret middle back\\slash\\nline and runI after',
    };
    writeFileSync(
      path,
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\n${encodeSeqlaneExecutionEvent(started)}\n${encodeSeqlaneExecutionEvent(event)}\n`,
    );

    let output = "";
    writeReplayEvents(path, { write: (value) => (output += value) }, [
      'a"b-secret',
      "back\\slash\\nline",
      "runI",
    ]);

    const lines = output.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(
      lines.every(
        (line) =>
          seqlaneExecutionEventSchema.safeParse(JSON.parse(line)).success,
      ),
    ).toBe(true);
    const parsed = JSON.parse(lines.at(-1) ?? "") as unknown;
    expect(seqlaneExecutionEventSchema.safeParse(parsed).success).toBe(true);
    expect(parsed).toMatchObject({
      type: "invocation.output",
      workId: "runI-work-identity",
      runId: "runI-run-identity",
      content: "before *** middle *** and *** after",
    });
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual([
      "type",
      "workId",
      "runId",
      "invocationId",
      "policy",
      "channel",
      "content",
      "metadata",
    ]);
    expect(output).toContain('"runId":"runI-run-identity"');
  });

  it("emits a valid prefix before reporting a malformed later record", () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-replay-"));
    directories.push(directory);
    const path = join(directory, "recording.jsonl");
    const event: SeqlaneExecutionEvent = {
      type: "run.started",
      metadata: {
        schemaVersion: 1,
        eventId: "event-1",
        sequence: 1,
        occurredAt: "2026-08-22T12:00:00.000Z",
      },
      workId: "work-1",
      runId: "run-1",
    };
    writeFileSync(
      path,
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\n${encodeSeqlaneExecutionEvent(event)}\nnot-json\n`,
    );

    let output = "";
    expect(() =>
      writeReplayEvents(path, { write: (value) => (output += value) }),
    ).toThrow("Invalid recording event JSON");
    const lines = output.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(
      seqlaneExecutionEventSchema.safeParse(JSON.parse(lines[0] ?? "")),
    ).toMatchObject({
      success: true,
    });
  });
});
