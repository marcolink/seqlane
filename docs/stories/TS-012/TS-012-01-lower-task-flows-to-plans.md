# TS-012-01 — Lower Task-Only Flows to Existing Plans

**Status:** completed

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

- [ADR-012 — Fluent Seqlane Flow DSL](../../ADR-012-fluent-seqlane-flow-dsl.md)
- [TS-012 — Fluent Flow DSL and Conditioned Repeat](../../TS-012-fluent-seqlane-flow-dsl.md)
- [TS-003 — Plan IR and Typed Dataflow](../../TS-003-seqlane-plan-ir-typed-dataflow.md)
