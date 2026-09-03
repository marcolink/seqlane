---
id: task.child-lifetime
title: Keep Invocation Active for Child Work
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Keep Invocation Active for Child Work

> Migrated from implementation story `TS-020-44`.

## User outcome

As a workflow author, an invocation does not complete while its child agents or
tracked subprocesses remain active.

## Scope

- Track child agent and process activity under one invocation.
- Delay invocation completion until activity reaches zero.

## Out of scope

- Child capability and lock inheritance.

## Implementation notes

Use explicit lifecycle events or adapter callbacks. A response completion alone
is not sufficient evidence that an invocation is complete.

## Acceptance criteria

**Scenario:** *A task starts child work*

- **Given:** A task response completes with an active tracked child
- **When:** The runtime evaluates completion
- **Then:** The parent invocation remains active

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
