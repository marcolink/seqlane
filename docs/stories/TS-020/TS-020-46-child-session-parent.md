# TS-020-46 — Bind Child Sessions to Parent Invocations

**Status:** completed

## User outcome

As a workflow author, each child executor session remains part of its parent
invocation.

## Scope

- Record parent invocation identity for child sessions.
- Route child lifecycle through the parent activity state.

## Out of scope

- Child runtime-authority comparison.

## Implementation notes

Child session IDs are executor-private. Seqlane stores only typed relationships
needed for lifecycle, locks, and events.

## Acceptance criteria

**Scenario:** *An executor creates a child session*

- **Given:** An active parent invocation
- **When:** The adapter reports a child session
- **Then:** The runtime records the parent invocation identity

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
