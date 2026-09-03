---
id: task.lock-before-request
title: Lock Workspace Before the First Request
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Lock Workspace Before the First Request

> Migrated from implementation story `TS-020-33`.

## User outcome

As a workflow author, Seqlane obtains workspace admission before executor work
starts.

## Scope

- Acquire workspace lock before `OpenCodeRun.prompt`.
- Cover the initial request path. Retry admission remains in task.retry-admission because
  the runtime does not yet execute retries.

## Out of scope

- Session lock ordering.

## Implementation notes

Use an adapter test double that records lock and prompt ordering. A late lock
acquisition is an error even if no conflict occurs in the test.

## Acceptance criteria

**Scenario:** *An exclusive task starts*

- **Given:** An exclusive invocation with a resolved workspace
- **When:** The executor receives its first request
- **Then:** Workspace admission was already acquired

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
