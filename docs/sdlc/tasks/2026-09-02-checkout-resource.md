---
id: task.checkout-resource
title: Use One Checkout Workspace Resource
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Use One Checkout Workspace Resource

> Migrated from implementation story `TS-020-28`.

## User outcome

As a runtime maintainer, version one treats a complete checkout as one lockable
workspace resource.

## Scope

- Map canonical identity to one full-checkout resource.
- Document the version-one resource boundary.

## Out of scope

- Directory and path-level locking.

## Implementation notes

The resource key has no task-selected subpath. This choice prevents overlapping
path-lock ambiguity in the first implementation.

## Acceptance criteria

**Scenario:** *Tasks name different files in one checkout*

- **Given:** Two file-accessing tasks in the same checkout
- **When:** The runtime resolves workspace resources
- **Then:** Both tasks receive the same workspace resource key

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
