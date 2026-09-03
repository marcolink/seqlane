---
id: task.no-definition-order
title: Remove Declaration-Order Execution
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Remove Declaration-Order Execution

> Migrated from implementation story `TS-020-05`.

## User outcome

As a workflow author, task declaration order does not create execution order.

## Scope

- Schedule from DAG readiness and admission only.
- Keep creation and lock queue order deterministic.

## Out of scope

- Changes to task source aliases.

## Implementation notes

Deliver this with concurrent admission scheduling. Do not use node creation or
array order as an execution dependency.

## Acceptance criteria

**Scenario:** *Independent declarations swap position*

- **Given:** Two equivalent workflows with reversed independent task calls
- **When:** Each scheduler starts
- **Then:** Neither workflow adds a dependency or forced execution order

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
