# TS-017-03 — Pause and Resume Isolated Studio Replay

**Status:** completed

## Summary

Give developers event-level control over Studio replay.

## Use Case

**As a** Seqlane developer, **I want to** pause and resume a recording in
Studio, **so that** I can inspect graph state after each execution event.

## Acceptance Criteria

**Scenario:** *The developer pauses playback*

- **Given:** A valid recording is playing in Studio
- **When:** I select Pause
- **Then:** Studio stops before the next event and keeps the current projection

**Scenario:** *The developer steps through one event*

- **Given:** A replay session is paused
- **When:** I select Step
- **Then:** Studio applies exactly one event and updates the graph projection

**Scenario:** *The developer resumes playback*

- **Given:** A replay session is paused before its final event
- **When:** I select Play
- **Then:** Studio applies the remaining events in order until completion or pause

**Scenario:** *Replay does not change live state*

- **Given:** Live Studio events continue while replay is active
- **When:** I inspect the replay graph
- **Then:** The graph contains replay events only, and no event is posted to Studio

**Scenario:** *Debug controls require replay mode*

- **Given:** I open Studio with `debug=1` but without an active replay source
- **When:** The browser loads the Studio page
- **Then:** Studio does not show replay debug controls

## Technical Details

Implement a replay state machine with paused, playing, and complete states.
Load the replay payload from `/api/replay/<replay-id>` when the URL contains a
replay ID. Show Play, Pause, Step, Reset, Exit replay, and 1x/2x/4x controls
only when `debug=1` and the replay payload is active. Reuse the existing
browser projection, graph, inspector, and timeline components.

## Out of Scope

- Arbitrary timeline seeking
- Editing or filtering recording events
- Workflow continuation or resumption
- Replay persistence across browser refreshes

## Source

- [ADR-017](../../ADR-017-studio-vite-development-and-isolated-replay.md)
- [TS-017](../../TS-017-studio-vite-development-and-isolated-replay.md)
- [ADR-013](../../ADR-013-local-read-only-execution-studio.md)
