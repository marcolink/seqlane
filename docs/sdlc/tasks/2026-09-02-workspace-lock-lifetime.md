---
id: task.workspace-lock-lifetime
title: Retain Workspace Lock for Invocation Effects
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Retain Workspace Lock for Invocation Effects

> Migrated from implementation story `TS-020-34`.

## User outcome

As a workflow author, a workspace lock remains held until all invocation
effects stop.

## Scope

- Connect lock release to reported activity and registered effect termination.
- Provide the common lifetime primitive that retries, child work, and tracked
  processes must register with when those execution paths are added.

## Out of scope

- Unmanaged external processes.
- Creating retry, child-work, and process execution paths.

## Implementation notes

Reuse the activity lifetime from session admission. The workspace lock cannot
release when the initial executor response completes.

## Acceptance criteria

**Scenario:** *An exclusive response starts a tracked process*

- **Given:** An exclusive invocation with a running tracked process
- **When:** Its initial response completes
- **Then:** Another workspace request remains waiting

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
