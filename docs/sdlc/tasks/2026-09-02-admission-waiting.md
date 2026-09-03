---
id: task.admission-waiting
title: Report Admission Waiting Without an Attempt
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Report Admission Waiting Without an Attempt

> Migrated from implementation story `TS-020-37`.

## User outcome

As a Seqlane observer, queued admission is visible without appearing as active
execution or a retry attempt.

## Scope

- Add waiting-for-admission event state.
- Preserve invocation identity and attempt accounting while queued.

## Out of scope

- User-interface presentation changes beyond event consumption.

## Implementation notes

Use a distinct waiting reason from dependency waiting. Emit active state only
after both locks are acquired.

## Acceptance criteria

**Scenario:** *A workspace request waits*

- **Given:** A dependency-ready invocation blocked by a lock
- **When:** The runtime emits progress
- **Then:** The invocation is waiting and its attempt count remains unchanged

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
