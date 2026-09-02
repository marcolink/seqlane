# TS-020-02 — Gate Dependent Invocations on Predecessor Success

**Status:** completed

## User outcome

As a workflow author, a dependent task does not start after its predecessor
fails.

## Scope

- Stop ordered execution at the first task error.
- Prove that a dependent executor does not run after predecessor failure.

## Out of scope

- Retry and concurrent scheduling.

## Implementation notes

The current runner stops the sequential program after a failed node. The test
asserts that the dependent executor has no call.

## Acceptance criteria

**Scenario:** *A predecessor fails*

- **Given:** A node that fails and a dependent node
- **When:** The runtime starts the Plan
- **Then:** The dependent node does not execute

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
