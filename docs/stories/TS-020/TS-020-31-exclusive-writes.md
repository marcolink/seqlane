# TS-020-31 — Admit Exclusive Workspace Policies

**Status:** completed

## User outcome

As a workflow author, an `exclusive` invocation executes alone in its workspace
resource.

## Scope

- Acquire exclusive workspace admission.
- Block concurrent shared and exclusive admissions while it is held.

## Out of scope

- Filesystem permissions or mutation detection.

## Implementation notes

Exclusive admission is independent of session identity and runtime authority.

## Acceptance criteria

**Scenario:** *A workspace has an active exclusive invocation*

- **Given:** An `exclusive` invocation that holds workspace admission
- **When:** Another invocation requests admission
- **Then:** The second invocation remains waiting

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
