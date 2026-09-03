---
id: task.dag-dependencies
title: Keep All Task Dependencies in the DAG
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Keep All Task Dependencies in the DAG

> Migrated from implementation story `TS-020-01`.

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

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
