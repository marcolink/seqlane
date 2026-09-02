import type { StudioReplayPayload } from "@seqlane/studio/protocol";
import { describe, expect, it } from "vitest";
import {
  advanceReplay,
  createReplaySession,
  pauseReplay,
  playReplay,
  replayControlsVisible,
  resetReplay,
  setReplaySpeed,
  stepReplay,
} from "./replay.js";
import {
  applyStreamEvent,
  createBrowserState,
} from "../../session/projection.js";

function payload(): StudioReplayPayload {
  return {
    replayId: "replay-1",
    workflowId: "workflow-1",
    fileName: "recording.jsonl",
    events: [
      {
        cursor: 1,
        workflowId: "workflow-1",
        event: {
          type: "run.started",
          workId: "work-1",
          runId: "run-1",
          metadata: {
            schemaVersion: 1,
            eventId: "event-1",
            sequence: 1,
            occurredAt: "2026-08-18T00:00:00.000Z",
          },
        },
      },
      {
        cursor: 2,
        workflowId: "workflow-1",
        event: {
          type: "run.succeeded",
          workId: "work-1",
          runId: "run-1",
          output: null,
          metadata: {
            schemaVersion: 1,
            eventId: "event-2",
            sequence: 2,
            occurredAt: "2026-08-18T00:00:01.000Z",
          },
        },
      },
    ],
  };
}

describe("Studio replay state machine", () => {
  it("loads paused with an empty projection and gates controls by debug mode", () => {
    const replay = createReplaySession(payload());

    expect(replay).toMatchObject({
      position: 0,
      playback: "paused",
      speed: 1,
    });
    expect(replay.projection.runs.size).toBe(0);
    expect(replayControlsVisible(false, replay)).toBe(false);
    expect(replayControlsVisible(true, replay)).toBe(true);
    expect(replayControlsVisible(true, undefined)).toBe(false);
  });

  it("steps exactly one event and pauses before the next event", () => {
    const replay = stepReplay(createReplaySession(payload()));

    expect(replay.position).toBe(1);
    expect(replay.playback).toBe("paused");
    expect(replay.projection.timeline.get("run-1")).toHaveLength(1);
  });

  it("plays in order and completes after the final event", () => {
    const recording = payload();
    let live = createBrowserState();
    for (const event of recording.events) {
      live = applyStreamEvent(live, event);
    }

    let replay = playReplay(createReplaySession(recording));
    replay = advanceReplay(replay);
    expect(replay.playback).toBe("playing");
    replay = advanceReplay(replay);

    expect(replay.position).toBe(2);
    expect(replay.playback).toBe("complete");
    expect(replay.projection.snapshots.get("run-1")?.summary.state).toBe(
      "succeeded",
    );
    expect(replay.projection).toEqual(live);
    expect(advanceReplay(replay)).toBe(replay);
  });

  it("pauses playback and resets the isolated projection", () => {
    let replay = playReplay(createReplaySession(payload()));
    replay = advanceReplay(replay);
    replay = pauseReplay(replay);
    expect(replay.playback).toBe("paused");
    expect(advanceReplay(replay)).toBe(replay);

    replay = setReplaySpeed(replay, 4);
    replay = resetReplay(replay);
    expect(replay).toMatchObject({ position: 0, playback: "paused", speed: 4 });
    expect(replay.projection.runs.size).toBe(0);
  });
});
