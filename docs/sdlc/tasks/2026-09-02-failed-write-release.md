---
id: task.failed-write-release
title: Release Failed Exclusive Admission After Activity Stops
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Release Failed Exclusive Admission After Activity Stops

> Migrated from implementation story `TS-020-51`.

## User outcome

As a workflow author, a failed exclusive invocation does not release workspace admission while
its activity remains active.

## Scope

- Couple failed invocation release to activity termination.
- Preserve the failure cause while waiting for cleanup.

## Out of scope

- Automatic workspace rollback.

## Implementation notes

An executor failure changes outcome but not admission lifetime. A later invocation must
not enter until all tracked effects stop.

## Acceptance criteria

**Scenario:** *An exclusive invocation fails with a running child*

- **Given:** A failed exclusive invocation with tracked active child work
- **When:** Another invocation requests the workspace
- **Then:** The second invocation remains waiting

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
