---
id: task.retry-admission
title: Retain Admission Across Retries
status: cancelled
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Retain Admission Across Retries

> Migrated from implementation story `TS-020-07`.

## User outcome

As a workflow author, a retried task retains its original session and workspace
admission.

## Scope

- Add retry execution inside one invocation lifetime.
- Retain session and workspace locks across the retry chain.

## Decision

Do not implement automatic retries now. Retrying a mutating invocation needs an
explicit retry-safety policy; this ADR story does not define one. The runtime
continues to make one attempt per invocation.

## Out of scope

- Durable retry recovery across process restart.

## Implementation notes

Deliver this after session and workspace lifetime rules. Retry events retain the
same invocation identity and do not create a concurrent attempt.

## Acceptance criteria

**Scenario:** *An exclusive task retries*

- **Given:** An exclusive task that fails once and then succeeds
- **When:** The runtime retries the task
- **Then:** No other task acquires its session or workspace lock between attempts

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
