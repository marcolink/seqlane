# TS-020-08 — Resolve One Session per Invocation

**Status:** completed

## User outcome

As a runtime maintainer, every invocation resolves one executor session before
execution.

## Scope

- Add private per-invocation session resolution.
- Attach the resolved session to admission state.

## Out of scope

- Session sharing policy and lock behavior.

## Implementation notes

Keep session contracts private and executor-neutral. A profile can resolve a
shared, isolated, or forked session in later stories.

## Acceptance criteria

**Scenario:** *A task becomes runnable*

- **Given:** A valid invocation
- **When:** Runtime setup completes
- **Then:** The invocation has exactly one resolved session before execution

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
