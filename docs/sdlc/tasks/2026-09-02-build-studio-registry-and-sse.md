---
id: task.build-studio-registry-and-sse
title: Build the In-Memory Studio Registry and SSE
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.local-read-only-execution-studio
supersedes: []
---

# Build the In-Memory Studio Registry and SSE

> Migrated from implementation story `TS-013-02`.

## Use Case

**As a** Studio browser client, **I want** a current run snapshot and live
stream, **so that** I can watch several registered runs without polling.

## Scope

- Accept authenticated local event-ingestion requests.
- Maintain an in-memory run registry and per-run reduced projections.
- Validate event metadata, deduplicate events, and set incomplete-run state.
- Provide run-list and run-detail snapshot endpoints.
- Provide one multiplexed SSE endpoint with a bounded replay buffer.
- Send `stream.reset` after a browser requests an evicted cursor.
- Use native `node:http`; do not add an HTTP framework.

## Out of Scope

- CLI event forwarding and browser graph components.
- Database storage, history export, remote access, and run control.
- Inference of missing events or reconstruction from log output.

## Implementation Notes

Ingestion accepts `StudioIngestEvent` only after a CLI supplies the session
capability. The first `run.started` event creates a record. A terminal record
remains available only within the transient service memory budget.

Use a Studio stream cursor for multiplexed browser events. Preserve each
canonical runner event and its per-run sequence inside that envelope. Retain
2,048 events and 100 terminal run projections at most.

## Acceptance Criteria

**Scenario:** *Two runs have isolated records*

- **Given:** Two CLI publishers send events for different run IDs
- **When:** Studio receives interleaved events
- **Then:** The run list has two summaries and each snapshot has only its run data

**Scenario:** *A browser receives live data without polling*

- **Given:** A connected SSE client
- **When:** Studio accepts a runner event
- **Then:** The client receives one stream event with a later cursor

**Scenario:** *A reconnect cannot replay evicted data*

- **Given:** A browser cursor older than the bounded event buffer
- **When:** The browser reconnects
- **Then:** Studio sends `stream.reset` and the browser can fetch a new snapshot

## Source

- [adr.local-read-only-execution-studio — Local Read-Only Execution Studio](../adrs/2026-09-02-local-read-only-execution-studio.md)
- [spec.local-read-only-execution-studio — Local Read-Only Execution Studio](../specs/2026-09-02-local-read-only-execution-studio.md)

## Traceability

- [spec.local-read-only-execution-studio](../specs/2026-09-02-local-read-only-execution-studio.md)
