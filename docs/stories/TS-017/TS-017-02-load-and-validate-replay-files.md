# TS-017-02 — Start Studio with a Validated Replay File

**Status:** completed

## Summary

Let developers start Studio with a bounded Seqlane recording without execution.

## Use Case

**As a** Seqlane developer, **I want to** start Studio with a canonical
recording file, **so that** I can open a ready-to-use replay URL without
running the workflow again.

## Acceptance Criteria

**Scenario:** *A valid recording starts replay mode*

- **Given:** I provide a valid version-1 Seqlane JSONL recording to Studio
- **When:** Studio starts with the replay option
- **Then:** Studio starts and prints a URL with an opaque replay identifier

**Scenario:** *A malformed recording prevents startup*

- **Given:** The replay file has invalid JSON, a bad header, or an invalid
  canonical event
- **When:** Studio starts with the replay option
- **Then:** Studio reports an error and does not start

**Scenario:** *The browser receives a bounded replay payload*

- **Given:** Studio started with a valid replay file
- **When:** The browser requests `/api/replay/<replay-id>`
- **Then:** The response contains validated events and no filesystem path

## Technical Details

Use the existing recording format and `@seqlane/events` decoder in
the service. Convert validated events to the existing `StudioStreamEvent`
shape. Preserve the 10 MiB, 10,000-event, sequence, event-ID, Work-ID, and
Run-ID limits. Generate an opaque replay ID and expose only that ID in the
printed URL.

## Out of Scope

- Uploading files through the browser
- Persisting files or replay position
- Supporting multiple runs in one recording

## Source

- [ADR-017](../../ADR-017-studio-vite-development-and-isolated-replay.md)
- [TS-017](../../TS-017-studio-vite-development-and-isolated-replay.md)
- [TS-016-04](../../TS-016/TS-016-04-recording-and-replay.md)
