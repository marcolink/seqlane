# TS-020-01 — Keep All Task Dependencies in the DAG

**Status:** completed

## User outcome

As a workflow author, every task dependency is visible in the Plan DAG.

## Scope

- Validate every Plan dependency edge and dependency cycle.
- Keep `PlanNode.dependsOn` as the dependency source of truth.

## Out of scope

- Session and workspace admission.

## Implementation notes

The runtime rejects cycles before it schedules a Plan. The regression test
contains a disconnected cycle.

## Acceptance criteria

**Scenario:** *A Plan contains a disconnected cycle*

- **Given:** A Plan with a cycle outside its output path
- **When:** The runtime validates the Plan
- **Then:** Validation rejects the Plan before execution starts

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
