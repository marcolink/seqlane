---
id: task.dataflow-dependencies
title: Derive Dataflow Dependencies
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Derive Dataflow Dependencies

> Migrated from implementation story `TS-020-03`.

## User outcome

As a workflow author, a task input reference creates the required Plan edge.

## Scope

- Derive dependencies from nested `ValueRef` bindings.
- Reject a serialized reference that lacks its dependency edge.

## Out of scope

- Order-only dependencies.

## Implementation notes

The builder deduplicates producer node IDs from the full input binding. The
regression test uses a nested producer value.

## Acceptance criteria

**Scenario:** *A nested input uses task output*

- **Given:** A task binding with a nested output reference
- **When:** The builder creates the Plan
- **Then:** The consumer depends on the producer exactly once

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
