# TS-020-29 — Add Shared-Exclusive Workspace Admission

**Status:** completed

## User outcome

As a runtime maintainer, each workspace resource has shared-exclusive admission.

## Scope

- Add a private lock registry by workspace identity.
- Support shared and exclusive acquisition requests.

## Out of scope

- Scheduler integration and queue event rendering.

## Implementation notes

Keep admission independent from executor code. Unit tests cover empty, shared,
and exclusive state transitions.

## Acceptance criteria

**Scenario:** *A workspace has active shared invocations*

- **Given:** Admission held by one or more shared invocations
- **When:** Another shared and an exclusive invocation request admission
- **Then:** The shared invocation can enter and the exclusive invocation waits

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
