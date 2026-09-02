# TS-020-42 — Preserve Exclusive Admission

**Status:** completed

## User outcome

As a workflow author, exclusive admission never allows concurrent workspace
work.

## Scope

- Keep workspace admission independent from runtime permissions.
- Test multiple exclusive sessions against one workspace resource.

## Out of scope

- Automatic repair or rollback after conflict.

## Implementation notes

Seqlane reports admission state. Exclusive policy still serializes conflicting
work.

## Acceptance criteria

**Scenario:** *Two exclusive invocations target one workspace*

- **Given:** Two exclusive invocations with separate sessions
- **When:** Both invocations become ready
- **Then:** Only one invocation becomes active

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
