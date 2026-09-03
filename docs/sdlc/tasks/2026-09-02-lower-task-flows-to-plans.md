---
id: task.lower-task-flows-to-plans
title: Lower Task-Only Flows to Existing Plans
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.fluent-seqlane-flow-dsl
supersedes: []
---

# Lower Task-Only Flows to Existing Plans

> Migrated from implementation story `TS-012-01`.

## Use Case

**As a** Seqlane author, **I want** a task-only Flow to build the current
Plan shape, **so that** the fluent API does not change task execution semantics.

## Scope

- Replay Flow declarations through the existing `WorkflowDefinition.build`.
- Reuse existing `run`, `ValueRef`, `InputBinding`, and dependency inference.
- Preserve deterministic task Plan-node IDs and task definition registration.
- Prove all supported task connection types with Flow DSL tests.
- Keep `defineWorkflow`, `buildWorkflow`, direct Plans, and Plan factories
  compatible.

## Out of Scope

- Repeat Plan nodes and recursive Plan validation.
- Runtime compiler, events, result lifetime, and fixture migration.

## Implementation Notes

Authoring aliases are source-only. A serialized task-only Plan must contain the
same node IDs, bindings, dependencies, and output bindings as the equivalent
`defineWorkflow` definition. Flow declaration order creates source order only.
References create dependencies.

## Acceptance Criteria

**Scenario:** *A Flow builds an existing task-only Plan*

- **Given:** A Flow with two connected tasks
- **When:** `buildWorkflow` builds the Flow definition
- **Then:** The Plan uses the existing `TaskNode` format and inferred edge

**Scenario:** *All task connection types remain available*

- **Given:** A Flow with workflow input, literals, nested references, fan-out,
  fan-in, independent tasks, repeated definitions, and final aggregation
- **When:** The Flow builds
- **Then:** Every binding and dependency matches its typed source reference

**Scenario:** *Aliases do not serialize*

- **Given:** Named Flow tasks
- **When:** The Plan serializes
- **Then:** The alias names are absent from the Plan data

## Source

- [adr.fluent-seqlane-flow-dsl — Fluent Seqlane Flow DSL](../adrs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [spec.fluent-seqlane-flow-dsl — Fluent Flow DSL and Conditioned Repeat](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [spec.seqlane-plan-ir-typed-dataflow — Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)

## Traceability

- [spec.fluent-seqlane-flow-dsl](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
