---
id: task.session-policies
title: Support Session Policies
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Support Session Policies

> Migrated from implementation story `TS-020-09`.

## User outcome

As a workflow author, tasks can use supported shared, isolated, or forked
session policies.

## Scope

- Define executor-neutral private session policy resolution.
- Implement supported OpenCode session creation paths.

## Out of scope

- Workspace admission and child sessions.

## Implementation notes

Reject unsupported policies before execution. Do not serialize executor session
objects into Plans or public authoring contracts.

## Acceptance criteria

**Scenario:** *A task uses an isolated session*

- **Given:** A profile with an isolated session policy
- **When:** The runtime resolves the invocation
- **Then:** It creates a session that no unrelated invocation receives

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
