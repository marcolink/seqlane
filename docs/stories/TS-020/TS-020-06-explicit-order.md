# TS-020-06 — Add Explicit Order-Only Dependencies

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
