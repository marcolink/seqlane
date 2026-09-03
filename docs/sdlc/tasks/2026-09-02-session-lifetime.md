---
id: task.session-lifetime
title: Hold Session Admission for Full Activity
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Hold Session Admission for Full Activity

> Migrated from implementation story `TS-020-12`.

## User outcome

As a workflow author, session admission covers all activity from an invocation.

## Scope

- Track requests, tools, retries, child work, cancellation, and stream end.
- Release the session only when all tracked activity terminates.

## Out of scope

- Workspace lock implementation.

## Implementation notes

Use one invocation activity counter or equivalent state. Do not release a
session when only the initial response has completed.

## Acceptance criteria

**Scenario:** *A task starts a tracked child action*

- **Given:** A response is complete while child activity continues
- **When:** Another invocation requests the session
- **Then:** The second invocation remains waiting

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
