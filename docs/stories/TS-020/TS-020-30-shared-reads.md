# TS-020-30 — Admit Shared Workspace Policies

**Status:** completed

## User outcome

As a workflow author, tasks declared `shared` may overlap in one workspace.

## Scope

- Integrate shared workspace policy with invocation admission.
- Prove concurrent execution with separate sessions.

## Out of scope

- Runtime permission enforcement.

## Implementation notes

`shared` is an author assertion about scheduling safety. It does not imply that
the runtime, shell, tools, or filesystem are read-only.

## Acceptance criteria

**Scenario:** *Two shared tasks have separate sessions*

- **Given:** Two ready `shared` invocations for one workspace
- **When:** Both pass session admission
- **Then:** Both acquire workspace admission and may execute concurrently

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
