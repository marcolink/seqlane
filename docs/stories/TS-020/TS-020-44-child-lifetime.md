# TS-020-44 — Keep Invocation Active for Child Work

**Status:** completed

## User outcome

As a workflow author, an invocation does not complete while its child agents or
tracked subprocesses remain active.

## Scope

- Track child agent and process activity under one invocation.
- Delay invocation completion until activity reaches zero.

## Out of scope

- Child capability and lock inheritance.

## Implementation notes

Use explicit lifecycle events or adapter callbacks. A response completion alone
is not sufficient evidence that an invocation is complete.

## Acceptance criteria

**Scenario:** *A task starts child work*

- **Given:** A task response completes with an active tracked child
- **When:** The runtime evaluates completion
- **Then:** The parent invocation remains active

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
