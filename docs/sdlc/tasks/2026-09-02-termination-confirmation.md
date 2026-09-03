---
id: task.termination-confirmation
title: Confirm Termination Before Session Release
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Confirm Termination Before Session Release

> Migrated from implementation story `TS-020-13`.

## User outcome

As a workflow author, cancellation does not make a session reusable too early.

## Scope

- Add executor termination confirmation.
- Retain session admission after cancel, timeout, or disconnect.

## Out of scope

- Session quarantine when confirmation fails.

## Implementation notes

Model a pending termination state. Do not use the completion of an abort request
as proof that executor work stopped.

## Acceptance criteria

**Scenario:** *Cancellation requests executor stop*

- **Given:** A session with active work
- **When:** The invocation is cancelled
- **Then:** The session remains unavailable until termination is confirmed

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
