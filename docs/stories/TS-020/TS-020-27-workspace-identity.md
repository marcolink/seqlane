# TS-020-27 — Resolve Canonical Workspace Identity

**Status:** completed

## User outcome

As a runtime maintainer, every task invocation has one canonical workspace
identity for scheduling.

## Scope

- Resolve one runtime workspace identity before admission.
- Normalize equivalent checkout paths before resource lookup.
- Use a run-scoped fallback identity when the runtime does not provide a path.

## Out of scope

- Filesystem access enforcement.

## Implementation notes

Workspace identity selects an admission resource only. It does not grant,
remove, or validate runtime authority.

## Acceptance criteria

**Scenario:** *Two paths refer to one checkout*

- **Given:** Equivalent runtime workspace paths
- **When:** The runtime resolves identities
- **Then:** Both invocations use the same canonical admission resource

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
