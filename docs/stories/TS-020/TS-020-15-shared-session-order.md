# TS-020-15 — Require Ordered Shared-Session Work

**Status:** completed

## User outcome

As a workflow author, tasks that intentionally share session context declare
their required order.

## Scope

- Detect shared-session task pairs during preflight.
- Accept pairs that have a transitive DAG dependency.

## Out of scope

- The unordered-pair rejection rule.

## Implementation notes

Use Plan reachability, not declaration order. This rule defines the permitted
case before the next story rejects the unsafe case.

## Acceptance criteria

**Scenario:** *Two tasks share one ordered session*

- **Given:** A shared-session task pair with a DAG path between them
- **When:** Preflight validates the workflow
- **Then:** Preflight accepts the pair

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
