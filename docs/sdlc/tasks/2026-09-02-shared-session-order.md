---
id: task.shared-session-order
title: Require Ordered Shared-Session Work
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Require Ordered Shared-Session Work

> Migrated from implementation story `TS-020-15`.

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

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
