# TS-020-17 — Admit Concurrent Sessions by Workspace Compatibility

**Status:** completed

## User outcome

As a workflow author, different sessions run together only when their workspace
policies are compatible.

## Scope

- Combine distinct-session and workspace-lock admission checks.
- Prevent concurrent incompatible workspace admission.

## Out of scope

- Definition-order scheduling changes.

## Implementation notes

Deliver this after shared-exclusive workspace admission. The scheduler must use both
admission results before it starts an invocation.

## Acceptance criteria

**Scenario:** *Different sessions request one workspace*

- **Given:** An exclusive and a shared invocation in separate sessions
- **When:** The exclusive invocation becomes active
- **Then:** The shared invocation waits for compatible workspace admission

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
