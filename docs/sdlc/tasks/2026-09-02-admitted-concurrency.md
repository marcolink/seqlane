---
id: task.admitted-concurrency
title: Schedule Admitted Independent Work Concurrently
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Schedule Admitted Independent Work Concurrently

> Migrated from implementation story `TS-020-04`.

## User outcome

As a workflow author, unrelated tasks can run together when their session and
workspace admission permits it.

## Scope

- Add dependency-aware concurrent scheduling.
- Start only ready invocations that have passed admission.

## Out of scope

- Retry policy and durable execution.

## Implementation notes

Deliver this after session and workspace locks exist. Preserve dependency
failure gating and deterministic event identity.

## Acceptance criteria

**Scenario:** *Two admitted tasks are independent*

- **Given:** Two ready tasks with separate sessions and compatible reads
- **When:** The scheduler starts the Plan
- **Then:** Both tasks become active before either task completes

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
