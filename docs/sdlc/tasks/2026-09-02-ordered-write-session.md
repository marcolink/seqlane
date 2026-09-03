---
id: task.ordered-write-session
title: Permit Ordered Exclusive Work in One Session
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Permit Ordered Exclusive Work in One Session

> Migrated from implementation story `TS-020-39`.

## User outcome

As a workflow author, explicitly ordered exclusive tasks can share one session.

## Scope

- Accept a shared session when each exclusive task pair has DAG order.
- Retain exclusive session and workspace admission.

## Out of scope

- Runtime permission diagnostics.

## Implementation notes

The DAG path defines the context order. Do not use prompt queue order as the
reason that preflight accepts the workflow.

## Acceptance criteria

**Scenario:** *Ordered exclusive tasks share a session*

- **Given:** Two exclusive tasks with an explicit dependency and one session
- **When:** Preflight validates the workflow
- **Then:** Preflight accepts the session assignment

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
