# TS-020-49 — Order Lock Queues Deterministically

**Status:** completed

## User outcome

As a workflow observer, lock waiting has deterministic invocation creation
order.

## Scope

- Order each admission queue by invocation creation sequence.
- Preserve that sequence in queue wake-up behavior.

## Out of scope

- Cross-Run global fairness.

## Implementation notes

Use an explicit creation ordinal, not task name or promise timing. Tests must
control resolution timing and assert the next admitted invocation.

## Acceptance criteria

**Scenario:** *Two writers wait for one lock*

- **Given:** Exclusive invocation A was created before exclusive invocation B
- **When:** The current exclusive invocation releases workspace admission
- **Then:** Invocation A receives admission before invocation B

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
