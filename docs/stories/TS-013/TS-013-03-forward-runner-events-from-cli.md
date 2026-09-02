# TS-013-03 — Forward Runner Events from the CLI

**Status:** completed

## Use Case

**As a** Seqlane user, **I want** a selected run to publish live events to
Studio, **so that** it appears with other local runs.

## Scope

- Add `--studio <descriptor-file>` to `seqlane run`.
- Load and validate the local Studio descriptor before runner startup.
- Create an ordered, finite, best-effort Studio publisher.
- Forward validated runner events with the selected workflow ID.
- Report a bounded local diagnostic after Studio delivery fails.
- Preserve the existing CLI renderer, cancellation, and exit-status behavior.

## Out of Scope

- Starting Studio automatically.
- Retrying a failed Studio connection until a run ends.
- Changing runner IPC, executor configuration, or workflow authoring.

## Implementation Notes

The publisher receives decoded events from existing CLI supervision. It must
not add an await point to the runner-event path. It must preserve metadata
sequence order for a run.

If forwarding fails, the publisher marks only its Studio copy unavailable. The
runner and selected terminal renderer continue normally.

## Acceptance Criteria

**Scenario:** *A selected run appears in Studio*

- **Given:** A valid local Studio descriptor
- **When:** The user runs `seqlane run --studio <descriptor-file>`
- **Then:** Studio receives the ordered canonical events with workflow context

**Scenario:** *Studio failure does not fail a run*

- **Given:** A Studio publisher whose service stops during a run
- **When:** The runner emits later events
- **Then:** The terminal renderer and runner terminal result remain unchanged

**Scenario:** *A remote descriptor is rejected*

- **Given:** A descriptor with a non-loopback address
- **When:** The user starts the run
- **Then:** The CLI rejects the descriptor before it starts a runner

## Source

- [ADR-013 — Local Read-Only Execution Studio](../../ADR-013-local-read-only-execution-studio.md)
- [TS-013 — Local Read-Only Execution Studio](../../TS-013-local-read-only-execution-studio.md)
- [ADR-002 — Dedicated Runner Process](../../ADR-002-dedicated-runner-process.md)
