import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStudioSession } from "./service.js";
import { StudioRegistry } from "./registry.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runStarted(
  runId: string,
  sequence = 1,
  eventId = `${runId}-${sequence}`,
): SeqlaneExecutionEvent {
  return {
    type: "run.started",
    metadata: {
      schemaVersion: 1,
      eventId,
      sequence,
      occurredAt: "2026-08-18T00:00:00.000Z",
    },
    workId: `work-${runId}`,
    runId,
  };
}

function recordingPath(content: string | Uint8Array): string {
  const directory = mkdtempSync(join(tmpdir(), "seqlane-studio-replay-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "private-recording.jsonl");
  writeFileSync(path, content);
  return path;
}

function recordingText(
  event: SeqlaneExecutionEvent = runStarted("replay-run"),
): string {
  return `${JSON.stringify({
    type: "seqlane.recording",
    version: 1,
    workflowId: "workflow-replay",
  })}\n${encodeSeqlaneExecutionEvent(event)}\n`;
}

async function ingest(
  address: string,
  event: SeqlaneExecutionEvent,
  workflowId: string,
): Promise<Response> {
  return fetch(`${address}/api/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ workflowId, event }),
  });
}

describe("Studio session", () => {
  it("starts on loopback with direct browser access", async () => {
    const session = await startStudioSession({ port: 0 });
    try {
      expect(new URL(session.address).hostname).toBe("127.0.0.1");
      expect(session.browserUrl).toBe(`${session.address}/`);
      await expect(fetch(`${session.address}/health`)).resolves.toMatchObject({
        status: 200,
      });
      await expect(fetch(session.browserUrl)).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      await session.stop();
    }
  });

  it("keeps replay data isolated from live ingestion", async () => {
    const path = recordingPath(recordingText());
    const session = await startStudioSession({ port: 0, replayFile: path });
    try {
      const browserUrl = new URL(session.browserUrl);
      const replayId = browserUrl.searchParams.get("replay");
      expect(replayId).toBeTruthy();
      expect(browserUrl.searchParams.get("debug")).toBe("1");
      expect(session.browserUrl).not.toContain(path);

      const runs = await fetch(`${session.address}/api/runs`);
      expect(await runs.json()).toEqual({ runs: [], cursor: 0 });

      const response = await fetch(
        `${session.address}/api/replay/${encodeURIComponent(replayId ?? "")}`,
      );
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        replayId,
        workflowId: "workflow-replay",
        fileName: "private-recording.jsonl",
        events: [
          {
            cursor: 1,
            workflowId: "workflow-replay",
            event: { type: "run.started" },
          },
        ],
      });
      expect(JSON.stringify(payload)).not.toContain(path);

      const liveResponse = await ingest(
        session.address,
        runStarted("live-run"),
        "workflow-live",
      );
      expect(liveResponse.status).toBe(202);

      const liveRuns = await fetch(`${session.address}/api/runs`);
      expect(await liveRuns.json()).toMatchObject({
        runs: [{ runId: "live-run", workflowId: "workflow-live" }],
      });

      const replayAfterLiveIngestion = await fetch(
        `${session.address}/api/replay/${encodeURIComponent(replayId ?? "")}`,
      );
      expect(await replayAfterLiveIngestion.json()).toEqual(payload);
    } finally {
      await session.stop();
    }
  });

  it("returns not found for an inactive replay identifier", async () => {
    const session = await startStudioSession({ port: 0 });
    try {
      const response = await fetch(`${session.address}/api/replay/unknown`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Replay not found" },
      });
    } finally {
      await session.stop();
    }
  });

  it.each([
    ["malformed JSON", "{\n", /header JSON/i],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe]), /UTF-8/i],
  ])("rejects %s before startup", async (_name, content, message) => {
    const path = recordingPath(content);
    await expect(
      startStudioSession({ port: 0, replayFile: path }),
    ).rejects.toThrow(message);
  });

  it("answers browser favicon requests without a not-found error", async () => {
    const session = await startStudioSession({ port: 0 });
    try {
      await expect(
        fetch(`${session.address}/favicon.ico`),
      ).resolves.toMatchObject({ status: 204 });
    } finally {
      await session.stop();
    }
  });

  it("accepts unauthenticated events and serves isolated snapshots", async () => {
    const session = await startStudioSession({ port: 0 });
    try {
      for (const runId of ["run-1", "run-2"]) {
        const response = await ingest(
          session.address,
          runStarted(runId),
          `workflow-${runId}`,
        );
        expect(response.status).toBe(202);
      }

      const list = await fetch(`${session.address}/api/runs`);
      expect(await list.json()).toMatchObject({
        runs: [
          { runId: "run-1", workflowId: "workflow-run-1" },
          { runId: "run-2", workflowId: "workflow-run-2" },
        ],
      });

      const detail = await fetch(`${session.address}/api/runs/run-1`);
      expect(await detail.json()).toMatchObject({
        summary: { runId: "run-1" },
        invocations: [],
      });
    } finally {
      await session.stop();
    }
  });

  it("does not expose browser run-control endpoints", async () => {
    const session = await startStudioSession({ port: 0 });
    try {
      for (const action of ["cancel", "retry", "approve"]) {
        const response = await fetch(
          `${session.address}/api/runs/run-1/${action}`,
          { method: "POST" },
        );
        expect(response.status).toBe(404);
      }
      const runs = await fetch(`${session.address}/api/runs`);
      expect(await runs.json()).toEqual({ runs: [], cursor: 0 });
    } finally {
      await session.stop();
    }
  });

  it("streams accepted events and resets stale cursors", async () => {
    const registry = new StudioRegistry();
    for (let index = 1; index <= 2_050; index += 1) {
      registry.ingest({
        workflowId: `workflow-${index}`,
        event: runStarted(`run-${index}`),
      });
    }
    const session = await startStudioSession({ port: 0, registry });
    try {
      const resetResponse = await fetch(`${session.address}/api/events`, {
        headers: { "last-event-id": "0" },
      });
      expect(resetResponse.status).toBe(200);
      const resetReader = resetResponse.body?.getReader();
      const resetChunk = await resetReader?.read();
      expect(new TextDecoder().decode(resetChunk?.value)).toContain(
        "event: stream.reset",
      );
      await resetReader?.cancel();

      const streamResponse = await fetch(`${session.address}/api/events`, {
        headers: { "last-event-id": "2050" },
      });
      expect(streamResponse.status).toBe(200);
      const reader = streamResponse.body?.getReader();
      const eventPromise = reader?.read();
      const response = await ingest(
        session.address,
        runStarted("live-run"),
        "workflow-live",
      );
      expect(response.status).toBe(202);
      const chunk = await eventPromise;
      const text = new TextDecoder().decode(chunk?.value);
      expect(text).toContain("id: 2051");
      expect(text).toContain('"runId":"live-run"');
      await reader?.cancel();
    } finally {
      await session.stop();
    }
  });
});
