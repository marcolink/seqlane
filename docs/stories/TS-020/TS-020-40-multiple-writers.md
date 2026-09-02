# TS-020-40 — Serialize Multiple Exclusive Invocations

**Status:** completed

## User outcome

As a workflow author, multiple `exclusive` invocations are valid and execute
one at a time for a workspace resource.

## Scope

- Serialize exclusive workspace admission.
- Remove multiple-writer diagnostics.

## Out of scope

- Runtime permission analysis.

## Implementation notes

Seqlane reports admission state, not inferred writer risk or permission
decisions.

## Acceptance criteria

**Scenario:** *Two exclusive invocations become ready*

- **Given:** Two ready `exclusive` invocations for one workspace resource
- **When:** They request admission
- **Then:** One runs and the other waits without a writer diagnostic

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
