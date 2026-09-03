---
id: task.exclusive-writes
title: Admit Exclusive Workspace Policies
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Admit Exclusive Workspace Policies

> Migrated from implementation story `TS-020-31`.

## User outcome

As a workflow author, an `exclusive` invocation executes alone in its workspace
resource.

## Scope

- Acquire exclusive workspace admission.
- Block concurrent shared and exclusive admissions while it is held.

## Out of scope

- Filesystem permissions or mutation detection.

## Implementation notes

Exclusive admission is independent of session identity and runtime authority.

## Acceptance criteria

**Scenario:** *A workspace has an active exclusive invocation*

- **Given:** An `exclusive` invocation that holds workspace admission
- **When:** Another invocation requests admission
- **Then:** The second invocation remains waiting

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
