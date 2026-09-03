---
id: task.add-repeat-plan-validation
title: Add RepeatNode Construction and Validation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.fluent-seqlane-flow-dsl
supersedes: []
---

# Add RepeatNode Construction and Validation

> Migrated from implementation story `TS-012-02`.

## Use Case

**As a** Seqlane author, **I want** a typed bounded repeat node, **so that**
a workflow can repeat static work until a typed condition is true.

## Scope

- Add `RepeatNode` and `RepeatBodyPlan` to the core Plan IR.
- Add `.repeat(name, options)` to the Flow builder.
- Construct deterministic repeat, body-input, and body-task node addresses.
- Extend Plan validation for repeat scopes, limits, and condition references.
- Add compile-time and runtime Plan-construction tests.

## Out of Scope

- Runtime execution, cancellation, events, and result lifetime.
- Nested repeat, `parallel`, `branch`, `foreach`, and nested workflows.

## Implementation Notes

The initial value and body output use one state type. The body receives local
state and a local `task` function only. The `until` callback returns a
`ValueRef<boolean>` and serializes as a reference. It must not store a
JavaScript predicate.

## Acceptance Criteria

**Scenario:** *A repeat has deterministic serializable structure*

- **Given:** A Flow with one repeat body
- **When:** The Flow builds
- **Then:** The Plan contains one `RepeatNode` with stable outer and body IDs

**Scenario:** *A valid condition is typed and scoped*

- **Given:** A body result with `passed: boolean`
- **When:** The author returns `output.passed` from `until`
- **Then:** The Flow type-checks and the condition references body data only

**Scenario:** *Invalid repeat Plans fail validation*

- **Given:** An invalid limit, empty body, invalid scope, cycle, or condition
- **When:** `validatePlan` validates the Plan
- **Then:** It reports a Seqlane-owned validation issue

## Source

- [adr.fluent-seqlane-flow-dsl — Fluent Seqlane Flow DSL](../adrs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [spec.fluent-seqlane-flow-dsl — Fluent Flow DSL and Conditioned Repeat](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [adr.seqlane-plan-ir-and-typed-dataflow — Plan IR and Typed Dataflow](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)

## Traceability

- [spec.fluent-seqlane-flow-dsl](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
