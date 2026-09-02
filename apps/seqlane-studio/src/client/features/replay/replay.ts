import type {
  StudioReplayPayload,
  StudioStreamEvent,
} from "@seqlane/studio/protocol";
import {
  applyStreamEvent,
  createBrowserState,
  type StudioBrowserState,
} from "../../session/projection.js";

export type ReplayPlayback = "paused" | "playing" | "complete";
export type ReplaySpeed = 1 | 2 | 4;

export interface StudioReplaySession {
  readonly replayId: string;
  readonly fileName: string;
  readonly recording: {
    readonly workflowId: string;
    readonly events: readonly StudioStreamEvent[];
  };
  readonly position: number;
  readonly playback: ReplayPlayback;
  readonly speed: ReplaySpeed;
  readonly projection: StudioBrowserState;
}

export function createReplaySession(
  payload: StudioReplayPayload,
): StudioReplaySession {
  return {
    replayId: payload.replayId,
    fileName: payload.fileName,
    recording: {
      workflowId: payload.workflowId,
      events: payload.events,
    },
    position: 0,
    playback: "paused",
    speed: 1,
    projection: createBrowserState(),
  };
}

export function replayControlsVisible(
  debugEnabled: boolean,
  replay: StudioReplaySession | undefined,
): boolean {
  return debugEnabled && replay !== undefined;
}

export function playReplay(replay: StudioReplaySession): StudioReplaySession {
  return replay.position >= replay.recording.events.length
    ? { ...replay, playback: "complete" }
    : { ...replay, playback: "playing" };
}

export function pauseReplay(replay: StudioReplaySession): StudioReplaySession {
  return replay.playback === "complete"
    ? replay
    : { ...replay, playback: "paused" };
}

export function setReplaySpeed(
  replay: StudioReplaySession,
  speed: ReplaySpeed,
): StudioReplaySession {
  return { ...replay, speed };
}

export function resetReplay(replay: StudioReplaySession): StudioReplaySession {
  return {
    ...replay,
    position: 0,
    playback: "paused",
    projection: createBrowserState(),
  };
}

function applyNextEvent(
  replay: StudioReplaySession,
  playback: ReplayPlayback,
): StudioReplaySession {
  const event = replay.recording.events[replay.position];
  if (event === undefined) return { ...replay, playback: "complete" };
  const position = replay.position + 1;
  return {
    ...replay,
    position,
    playback:
      position >= replay.recording.events.length ? "complete" : playback,
    projection: applyStreamEvent(replay.projection, event),
  };
}

export function stepReplay(replay: StudioReplaySession): StudioReplaySession {
  if (replay.playback !== "paused") return replay;
  return applyNextEvent(replay, "paused");
}

export function advanceReplay(
  replay: StudioReplaySession,
): StudioReplaySession {
  if (replay.playback !== "playing") return replay;
  return applyNextEvent(replay, "playing");
}
