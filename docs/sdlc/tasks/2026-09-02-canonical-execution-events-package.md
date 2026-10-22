---
id: task.canonical-execution-events-package
title: Create the Canonical Execution-Events Package
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.consumer-agnostic-seqlane-execution-events
supersedes: []
---

# Create the Canonical Execution-Events Package

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-016-00`.

## Summary

Give every execution observer one stable, consumer-agnostic event contract.

## Use Case

**As a** Seqlane consumer author, **I want to** consume a public canonical
execution-event union, **so that** I can build output, Studio, recording, or
observability projections without depending on runner internals.

## Acceptance Criteria

**Scenario:** _Consumers import one canonical event union_

- **Given:** A consumer depends on `@seqlane/events`
- **When:** It handles a serialized execution event
- **Then:** It can use `SeqlaneExecutionEvent` and all existing lifecycle
  variants without importing `RunnerEvent` from `seqlane-core`

**Scenario:** _Events round-trip safely_

- **Given:** A valid event has metadata and a JSON-safe payload
- **When:** It is encoded and decoded
- **Then:** The decoded event is equivalent and passes the canonical guard

**Scenario:** _Malformed events are rejected_

- **Given:** An event has invalid metadata, IDs, timestamps, sequence, or
  trace context
- **When:** It crosses the canonical protocol boundary
- **Then:** Validation fails without accepting unknown unsafe fields

## Technical Details

Create `libs/seqlane-events` and export `SeqlaneExecutionEvent`, metadata,
guards, JSON encoding/decoding, and `SeqlaneExecutionEventConsumer`. Move the
serialized event definitions out of `seqlane-core`; keep shared IDs and Plan
IR in `seqlane-core`. The package has no runtime-engine, executor, Studio, output, or
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

## Source and current owners

- [adr.consumer-agnostic-seqlane-execution-events](../adrs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)

## Traceability

- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
