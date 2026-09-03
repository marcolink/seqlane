---
id: task.session-workspace-compatibility
title: Admit Concurrent Sessions by Workspace Compatibility
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Admit Concurrent Sessions by Workspace Compatibility

> Migrated from implementation story `TS-020-17`.

## User outcome

As a workflow author, different sessions run together only when their workspace
policies are compatible.

## Scope

- Combine distinct-session and workspace-lock admission checks.
- Prevent concurrent incompatible workspace admission.

## Out of scope

- Definition-order scheduling changes.

## Implementation notes

Deliver this after shared-exclusive workspace admission. The scheduler must use both
admission results before it starts an invocation.

## Acceptance criteria

**Scenario:** *Different sessions request one workspace*

- **Given:** An exclusive and a shared invocation in separate sessions
- **When:** The exclusive invocation becomes active
- **Then:** The shared invocation waits for compatible workspace admission

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
