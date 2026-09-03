---
id: task.unmanaged-process-limit
title: Document Unmanaged-Process Limits
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Document Unmanaged-Process Limits

> Migrated from implementation story `TS-020-54`.

## User outcome

As a workflow author, I know the boundary of Seqlane workspace coordination.

## Scope

- Document that Seqlane coordinates only managed sessions and processes.
- State the risk from external unmanaged workspace activity.

## Out of scope

- Detection or control of external processes.

## Implementation notes

Update runtime and executor documentation. Do not claim that a workspace lock
coordinates processes that do not report to Seqlane.

## Acceptance criteria

**Scenario:** *A user uses the supported executor documentation*

- **Given:** The runtime and OpenCode documentation
- **When:** The user looks for workspace coordination guarantees
- **Then:** The documents state the unmanaged-process limitation

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
