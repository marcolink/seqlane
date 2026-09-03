---
id: task.lock-order
title: Acquire Locks in Global Order
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Acquire Locks in Global Order

> Migrated from implementation story `TS-020-36`.

## User outcome

As a runtime maintainer, admission cannot deadlock from inconsistent lock
acquisition order.

## Scope

- Acquire workspace locks before session locks.
- Enforce that order in the admission implementation.

## Out of scope

- Lock queue fairness and starvation policy.

## Implementation notes

Keep one acquisition function so no executor path can reverse the order. Tests
use crossed resource requests to prove no wait cycle forms.

## Acceptance criteria

**Scenario:** *Two invocations need the same resources*

- **Given:** Concurrent admission requests with shared workspace and session
- **When:** The runtime acquires locks
- **Then:** Both requests use workspace before session order

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
