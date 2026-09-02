# TS-020-32 — Block Shared Admission Behind Exclusive Work

**Status:** completed

## User outcome

As a workflow author, a `shared` task waits while an `exclusive` task is
running in the same workspace resource.

## Scope

- Block shared admission while exclusive admission is active.
- Release queued work after exclusive work ends.

## Out of scope

- Claims about what runtime tools can modify.

## Implementation notes

The runtime does not inspect task prompts, commands, tools, or permissions to
validate the policy declaration.

## Acceptance criteria

**Scenario:** *A shared invocation waits behind an exclusive invocation*

- **Given:** An active `exclusive` workspace admission
- **When:** A `shared` invocation becomes dependency-ready
- **Then:** It does not execute before exclusive admission is released

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
