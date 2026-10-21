---
id: task.effect-v4-telemetry-and-event-pressure
title: Telemetry sinks and event pressure
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-classifier-and-deadlines
supersedes: []
---

# Telemetry sinks and event pressure

## Objective

Use a real mixed run to correlate CLI/worker/runtime/invocation/adapter spans, canonical observations, metrics, and structured logs.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Use a real mixed run to correlate CLI/worker/runtime/invocation/adapter spans, canonical observations, metrics, and structured logs.
- Exercise large payloads, bounded byte queues, slow IPC, exporter failure, and terminal flush.
- Connect an in-process collector first; add explicit OTLP configuration without enabling remote raw-data export by default.

## Affected areas

event bridge, runner transport, private telemetry services, adapter observation callers, and `libs/tui`.

## Verification

exact canonical payload round trips, correct parent/link IDs, complete-record eviction notices, bounded queues, and unchanged result on exporter failure.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove remaining old observability context, projections, flush hooks, and dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-classifier-and-deadlines: prerequisite task](./2026-10-21-effect-v4-classifier-and-deadlines.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
