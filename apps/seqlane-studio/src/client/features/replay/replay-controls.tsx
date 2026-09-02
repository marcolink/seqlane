import { LogOut, Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Select } from "../../components/ui/select.js";
import { Label, Text } from "../../components/ui/typography.js";
import type { ReplaySpeed, StudioReplaySession } from "./replay.js";

export function ReplayControls({
  replay,
  visible,
  onExit,
  onPause,
  onPlay,
  onReset,
  onSetSpeed,
  onStep,
}: {
  readonly replay: StudioReplaySession | undefined;
  readonly visible: boolean;
  readonly onExit: () => void;
  readonly onPause: () => void;
  readonly onPlay: () => void;
  readonly onReset: () => void;
  readonly onSetSpeed: (speed: ReplaySpeed) => void;
  readonly onStep: () => void;
}) {
  if (replay === undefined) return null;
  const isPlaying = replay.playback === "playing";
  const isComplete = replay.playback === "complete";

  return (
    <section className="replay-controls" aria-label="Replay controls">
      <div>
        <Label as="p" className="eyebrow">
          Replay mode · debug controls
        </Label>
        <Text as="p" className="replay-source" role="status">
          {replay.fileName} · event {replay.position} of{" "}
          {replay.recording.events.length}
          {isComplete ? " · complete" : ""}
        </Text>
      </div>
      {visible ? (
        <div className="replay-control-row">
          <Button
            appearance="primary"
            className="replay-primary"
            size="compact"
            onClick={onPlay}
            disabled={isPlaying || isComplete}
          >
            <Play aria-hidden="true" /> Play
          </Button>
          <Button size="compact" onClick={onPause} disabled={!isPlaying}>
            <Pause aria-hidden="true" /> Pause
          </Button>
          <Button
            size="compact"
            onClick={onStep}
            disabled={isPlaying || isComplete}
          >
            <StepForward aria-hidden="true" /> Step
          </Button>
          <Button size="compact" onClick={onReset}>
            <RotateCcw aria-hidden="true" /> Reset
          </Button>
          <Select
            aria-label="Replay speed"
            id="replay-speed"
            label="Speed"
            name="replay-speed"
            value={replay.speed}
            onChange={(event) =>
              onSetSpeed(Number(event.target.value) as ReplaySpeed)
            }
          >
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </Select>
          <Button size="compact" onClick={onExit}>
            <LogOut aria-hidden="true" /> Exit replay
          </Button>
        </div>
      ) : null}
      <Text
        as="p"
        className="replay-status"
        aria-live="polite"
        tone="muted"
        variant="meta"
      >
        Playback: {replay.playback}
      </Text>
    </section>
  );
}
