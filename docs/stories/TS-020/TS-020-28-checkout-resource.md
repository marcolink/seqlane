# TS-020-28 — Use One Checkout Workspace Resource

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
