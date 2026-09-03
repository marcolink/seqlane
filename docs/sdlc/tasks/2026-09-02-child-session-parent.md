---
id: task.child-session-parent
title: Bind Child Sessions to Parent Invocations
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Bind Child Sessions to Parent Invocations

> Migrated from implementation story `TS-020-46`.

## User outcome

As a workflow author, each child executor session remains part of its parent
invocation.

## Scope

- Record parent invocation identity for child sessions.
- Route child lifecycle through the parent activity state.

## Out of scope

- Child runtime-authority comparison.

## Implementation notes

Child session IDs are executor-private. Seqlane stores only typed relationships
needed for lifecycle, locks, and events.

## Acceptance criteria

**Scenario:** *An executor creates a child session*

- **Given:** An active parent invocation
- **When:** The adapter reports a child session
- **Then:** The runtime records the parent invocation identity

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
