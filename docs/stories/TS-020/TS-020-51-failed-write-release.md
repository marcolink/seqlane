# TS-020-51 — Release Failed Exclusive Admission After Activity Stops

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
