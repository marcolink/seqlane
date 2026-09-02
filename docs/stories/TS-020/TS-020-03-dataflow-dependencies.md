# TS-020-03 — Derive Dataflow Dependencies

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
