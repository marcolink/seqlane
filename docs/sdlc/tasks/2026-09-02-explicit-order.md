---
id: task.explicit-order
title: Add Explicit Order-Only Dependencies
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Add Explicit Order-Only Dependencies

> Migrated from implementation story `TS-020-06`.

## User outcome

As a workflow author, I can require task order without passing task output.

## Scope

- Accept prior invocations through `dependsOn`.
- Support direct workflows, Flow handles, and repeat bodies.

## Out of scope

- Runtime session and workspace admission.

## Implementation notes

The builder merges explicit and dataflow dependencies. Flow resolves a named
prior handle to its output reference.

## Acceptance criteria

**Scenario:** *A task needs order but no data*

- **Given:** A task that lists a prior invocation in `dependsOn`
- **When:** The builder creates the Plan
- **Then:** The Plan contains the explicit dependency edge

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
