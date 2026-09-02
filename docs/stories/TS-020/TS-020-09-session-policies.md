# TS-020-09 — Support Session Policies

**Status:** completed

## User outcome

As a workflow author, tasks can use supported shared, isolated, or forked
session policies.

## Scope

- Define executor-neutral private session policy resolution.
- Implement supported OpenCode session creation paths.

## Out of scope

- Workspace admission and child sessions.

## Implementation notes

Reject unsupported policies before execution. Do not serialize executor session
objects into Plans or public authoring contracts.

## Acceptance criteria

**Scenario:** *A task uses an isolated session*

- **Given:** A profile with an isolated session policy
- **When:** The runtime resolves the invocation
- **Then:** It creates a session that no unrelated invocation receives

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
