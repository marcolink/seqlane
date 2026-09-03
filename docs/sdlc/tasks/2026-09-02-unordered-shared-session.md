---
id: task.unordered-shared-session
title: Reject Unordered Shared-Session Work
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Reject Unordered Shared-Session Work

> Migrated from implementation story `TS-020-16`.

## User outcome

As a workflow author, ambiguous work cannot silently share one session.

## Scope

- Reject unordered task pairs that resolve the same session.
- Report a typed preflight diagnostic with both task identities.

## Out of scope

- Alternative deterministic session ordering.

## Implementation notes

Rejecting is the selected safe policy. Do not replace rejection with lexical or
declaration ordering.

## Acceptance criteria

**Scenario:** *Two independent tasks share a session*

- **Given:** Independent tasks that resolve the same session
- **When:** Preflight validates the workflow
- **Then:** Preflight fails before the executor creates a request

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
