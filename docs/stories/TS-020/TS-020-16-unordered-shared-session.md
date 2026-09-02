# TS-020-16 — Reject Unordered Shared-Session Work

**Status:** completed

## User outcome

As a workflow author, ambiguous work cannot silently share one session.

## Scope

- Reject unordered task pairs that resolve the same session.
- Report a typed preflight diagnostic with both task identities.

## Out of scope

- Alternative deterministic session ordering.

## Implementation notes

Rejecting is the selected safe policy. Do not replace rejection with lexical or
declaration ordering.

## Acceptance criteria

**Scenario:** *Two independent tasks share a session*

- **Given:** Independent tasks that resolve the same session
- **When:** Preflight validates the workflow
- **Then:** Preflight fails before the executor creates a request

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
