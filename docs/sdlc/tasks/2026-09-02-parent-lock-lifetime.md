---
id: task.parent-lock-lifetime
title: Retain Parent Locks for Child Sessions
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Retain Parent Locks for Child Sessions

> Migrated from implementation story `TS-020-48`.

## User outcome

As a workflow author, a parent invocation retains its workspace lock while any
child session is active.

## Scope

- Join child session lifetime to parent workspace admission.
- Release the lock only after parent and children terminate.

## Out of scope

- Unmanaged child sessions that the adapter cannot report.

## Implementation notes

Child completion updates the parent activity counter. Do not transfer the
workspace lock to a child as a separate resource owner.

## Acceptance criteria

**Scenario:** *A parent response ends before its child*

- **Given:** A parent exclusive invocation with an active child session
- **When:** The parent response completes
- **Then:** A competing workspace request remains waiting

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
