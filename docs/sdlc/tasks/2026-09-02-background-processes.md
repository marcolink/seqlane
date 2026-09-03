---
id: task.background-processes
title: Track or Prohibit Mutating Background Processes
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Track or Prohibit Mutating Background Processes

> Migrated from implementation story `TS-020-45`.

## User outcome

As a workflow author, a mutating background process remains tracked or the
executor prohibits it.

## Scope

- Classify mutating background process requests.
- Track their lifecycle or reject unsupported background execution.

## Out of scope

- Coordination of processes external to Seqlane.

## Implementation notes

Fail closed when the adapter cannot report process termination. The workspace
lock remains held while a tracked process runs.

## Acceptance criteria

**Scenario:** *An exclusive task starts a background formatter*

- **Given:** A mutating background process request
- **When:** The adapter cannot track its lifetime
- **Then:** Seqlane rejects the request

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
