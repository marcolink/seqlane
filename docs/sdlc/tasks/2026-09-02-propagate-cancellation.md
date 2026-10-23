---
id: task.propagate-cancellation
title: Cancel an active workflow and propagate abort
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Cancel an active workflow and propagate abort

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-06`.

## Use Case

**As a** workflow operator, **I want to** cancel an active workflow, **so that** the running executor can stop work promptly and safely.

## Acceptance Criteria

**Scenario:** _Cancellation reaches the active executor_

- **Given:** A workflow run is active and a Seqlane runner receives `CancelRun`
- **When:** The runtime processes the cancellation
- **Then:** Cancellation reaches the active executor through its `AbortSignal`

**Scenario:** _Cancellation remains behind the Seqlane boundary_

- **Given:** The executor observes the abort signal
- **When:** The active operation terminates
- **Then:** The runtime handles cancellation through Seqlane’s runner path without exposing runtime objects or cancellation types to consumers

## Technical Details

The original slice propagated a runner cancellation request to the active executor. It kept cancellation details behind the private runtime boundary.

## Out of Scope

- Suspend/resume
- Durable execution history
- Durable or multi-process cancellation recovery

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
