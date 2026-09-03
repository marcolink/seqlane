---
id: task.build-static-plans
title: Build static Plans from typed dataflow
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.seqlane-plan-ir-typed-dataflow
supersedes: []
---

# Build static Plans from typed dataflow

> Migrated from implementation story `TS-003-02`.

## Use Case

**As a** workflow author, **I want to** invoke typed tasks in a workflow and receive a static Plan, **so that** data references automatically define the DAG.

## Scope

- Implement typed task invocation during workflow Plan construction.
- Allocate deterministic, unique invocation IDs.
- Derive each `TaskNode.dependsOn` from all input `ValueRef` targets.
- Build typed workflow output bindings without executing task work.
- Add unit and type tests for linear, fan-in, independent, and repeated invocations.

## Out of Scope

- Parallel runtime execution or lowering structured control flow.
- Manually declared dependency APIs.
- Runtime compilation changes other than compatibility fixes required by generated Plan data.

## Implementation Notes

`run(task, { input })` is a plan-building operation. It collects a serializable TaskNode and returns an invocation result containing an output reference. References to workflow input do not create a dependency; references to prior task invocations create exactly one dependency per target. A built Plan must pass existing runtime validation.

## Acceptance Criteria

**Scenario:** *Dataflow creates dependencies*
- **Given:** A task input binds a prior invocation output
- **When:** The workflow is built
- **Then:** The Plan contains a dependency edge to that invocation without an author-supplied sequence declaration

**Scenario:** *Independent work remains independent in the Plan*
- **Given:** Two task invocations bind only literals or workflow input
- **When:** The workflow is built
- **Then:** Neither TaskNode depends on the other

**Scenario:** *Plan construction has no task side effects*
- **Given:** A workflow is built
- **When:** Its Plan is inspected
- **Then:** No executor or task callback has run and the output is a serializable Seqlane Plan

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.seqlane-plan-ir-and-typed-dataflow — Use a Seqlane-Owned Plan IR with Typed Dataflow](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
- [spec.seqlane-plan-ir-typed-dataflow — Seqlane Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)

## Traceability

- [spec.seqlane-plan-ir-typed-dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)
