# TS-018-04 — Emit and Consume Agent Warnings

**Status:** planned

## User outcome

As a CLI or Studio consumer, I can display the same structured warning when a
Run changes model without relying on adapter log text.

## Scope

- Add the canonical `run.warning` event.
- Validate, encode, and decode warning events.
- Include stable codes and structured transition details.
- Emit warnings immediately before the affected invocation.
- Render warnings in CLI output.
- Project warnings in Studio.
- Preserve warnings in recording and replay.

## Out of scope

- Warning-to-error promotion modes.
- OpenTelemetry exporters.
- New session behavior.
- Raw OpenCode diagnostics.

## Implementation notes

Use the existing consumer-agnostic event metadata and versioning rules. Keep
warning messages for people and stable codes/details for consumers. Warnings
do not change the Run exit status in the first iteration.

## Acceptance criteria

**Scenario:** *A model transition emits one warning*

- **Given:** A safe model-only profile transition affects one task
- **When:** The task invocation starts
- **Then:** One canonical warning identifies the Plan node and both agent keys

**Scenario:** *CLI renders a warning*

- **Given:** The CLI receives a valid warning event
- **When:** It renders the Run
- **Then:** It shows the warning code and affected task without parsing message text

**Scenario:** *Studio consumes a warning*

- **Given:** Studio receives a valid warning event
- **When:** It reduces the event
- **Then:** The warning remains available for the affected Run/invocation

**Scenario:** *Malformed warning data is rejected*

- **Given:** A warning has invalid IDs, code, or non-JSON details
- **When:** It crosses the canonical event boundary
- **Then:** Decoding fails

**Scenario:** *Replay preserves warnings*

- **Given:** A recording contains a warning event
- **When:** Studio replays the recording
- **Then:** The warning appears in the same event order

## Source

- [ADR-018](../../ADR-018-runtime-resolved-execution-profiles.md)
- [TS-018](../../TS-018-runtime-resolved-execution-profiles.md)
