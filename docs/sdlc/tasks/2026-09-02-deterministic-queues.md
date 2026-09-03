---
id: task.deterministic-queues
title: Order Lock Queues Deterministically
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Order Lock Queues Deterministically

> Migrated from implementation story `TS-020-49`.

## User outcome

As a workflow observer, lock waiting has deterministic invocation creation
order.

## Scope

- Order each admission queue by invocation creation sequence.
- Preserve that sequence in queue wake-up behavior.

## Out of scope

- Cross-Run global fairness.

## Implementation notes

Use an explicit creation ordinal, not task name or promise timing. Tests must
control resolution timing and assert the next admitted invocation.

## Acceptance criteria

**Scenario:** *Two writers wait for one lock*

- **Given:** Exclusive invocation A was created before exclusive invocation B
- **When:** The current exclusive invocation releases workspace admission
- **Then:** Invocation A receives admission before invocation B

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
