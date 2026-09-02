# TS-016-00 — Create the Canonical Execution-Events Package

**Status:** completed

## Summary

Give every execution observer one stable, consumer-agnostic event contract.

## Use Case

**As a** Seqlane consumer author, **I want to** consume a public canonical
execution-event union, **so that** I can build output, Studio, recording, or
observability projections without depending on runner internals.

## Acceptance Criteria

**Scenario:** *Consumers import one canonical event union*

- **Given:** A consumer depends on `@seqlane/events`
- **When:** It handles a serialized execution event
- **Then:** It can use `SeqlaneExecutionEvent` and all existing lifecycle
  variants without importing `RunnerEvent` from `seqlane-core`

**Scenario:** *Events round-trip safely*

- **Given:** A valid event has metadata and a JSON-safe payload
- **When:** It is encoded and decoded
- **Then:** The decoded event is equivalent and passes the canonical guard

**Scenario:** *Malformed events are rejected*

- **Given:** An event has invalid metadata, IDs, timestamps, sequence, or
  trace context
- **When:** It crosses the canonical protocol boundary
- **Then:** Validation fails without accepting unknown unsafe fields

## Technical Details

Create `libs/seqlane-events` and export `SeqlaneExecutionEvent`, metadata,
guards, JSON encoding/decoding, and `SeqlaneExecutionEventConsumer`. Move the
serialized event definitions out of `seqlane-core`; keep shared IDs and Plan
IR in `seqlane-core`. The package has no Mastra, executor, Studio, output, or
OTel dependencies. Use declared package exports across boundaries.

Dependencies: none. Likely files: `libs/seqlane-events/**`,
`libs/seqlane-core/src/runner-protocol.ts`, package/project configuration,
and protocol tests. Verify with package tests, type checks, JSON round-trip
tests, malformed-input tests, and dependency-boundary checks.

## Out of Scope

- Runtime event projection or `run.plan` creation
- CLI consumer wiring
- Studio or recording implementation
- OpenTelemetry and CloudEvents adapters

## Source

- [ADR-016](../../ADR-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-016](../../TS-016-consumer-agnostic-seqlane-execution-events.md)
