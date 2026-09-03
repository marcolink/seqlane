---
id: task.recording-and-replay
title: Record and Replay Canonical Execution Streams
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.consumer-agnostic-seqlane-execution-events
supersedes: []
---

# Record and Replay Canonical Execution Streams

> Migrated from implementation story `TS-016-04`.

## Summary

Make real executions repeatable for offline debugging.

## Use Case

**As a** Seqlane developer, **I want to** record and replay a real event
stream, **so that** I can inspect graph and lifecycle behavior without running
the workflow again.

## Acceptance Criteria

**Scenario:** *A recording preserves the complete run*

- **Given:** Recording is explicitly enabled for a run
- **When:** Canonical events are emitted
- **Then:** The recording stores the ordered JSON-safe stream, including
  metadata and `run.plan`, without a Studio-specific event format

**Scenario:** *Replay renders the planned graph before execution state*

- **Given:** A recording contains only `run.started` and `run.plan`
- **When:** It is replayed into the Studio projection
- **Then:** Studio renders the complete static graph without loading or
  executing the workflow

**Scenario:** *Replay matches live projection state*

- **Given:** A complete recording was produced by a live run
- **When:** Its events are replayed in sequence
- **Then:** The final Studio projection matches the live projection, including
  repeated invocation instances and terminal state

## Technical Details

Implement recording as a generic `SeqlaneExecutionEventConsumer` using the
canonical JSON encoder/decoder and bounded local developer output. Add a
read-only replay path that feeds the same event projection used by live
ingestion. Warn that execution data is written to disk; preserve redaction and
size bounds. Replay must never invoke workflow loading, executors, or runner
commands.

Dependencies: task.canonical-execution-events-package, task.runtime-plan-snapshot-events, task.cli-consumer-fanout, and task.studio-static-plan-projection. Likely files:
CLI recording options/wiring, a recorder/replay module, Studio projection
tests, and documentation. Verify stream round-trip, prefix replay, complete
replay equivalence, malformed-recording rejection, and no-execution behavior.

## Out of Scope

- Workflow resumption or continuation from a recording
- Persistent database-backed event history
- Raw executor transcript persistence
- Remote event transport or sharing

## Source

- [adr.consumer-agnostic-seqlane-execution-events](../adrs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [rfc.execution-observability-and-debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)

## Traceability

- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
