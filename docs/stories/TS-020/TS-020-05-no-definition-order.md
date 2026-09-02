# TS-020-05 — Remove Declaration-Order Execution

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
