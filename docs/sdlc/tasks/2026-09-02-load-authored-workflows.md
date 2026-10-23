---
id: task.load-authored-workflows
title: Load authored workflows in the runtime
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.seqlane-plan-ir-typed-dataflow
supersedes: []
---

# Load authored workflows in the runtime

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-003-03`.

## Use Case

**As a** Seqlane operator, **I want to** run an authored workflow through the existing child runner, **so that** typed authoring reaches the private compiler without changing the IPC boundary.

## Scope

- Extend runtime loading to recognize a core workflow definition.
- Build and validate its Plan inside the runner process.
- Supply the definition's in-memory task schemas to the existing compiler.
- Preserve existing Plan and Plan-factory loading compatibility.

## Out of Scope

- Passing executable workflow definitions or callbacks across IPC.
- Exposing runtime or runtime-engine types from core.
- Replacing the existing executor seam or implementing OpenCode transport.

## Implementation Notes

The runner still imports the selected module itself. It keeps the workflow definition, schema registry, executor registry, and compiled runtime state inside the child. Only existing Seqlane-owned JSON protocol messages cross to the CLI. Runtime binding resolution remains authoritative for Plan execution.

## Acceptance Criteria

**Scenario:** _Authored workflow builds in the child_

- **Given:** A runner receives a reference to a module exporting a workflow definition
- **When:** It loads the module
- **Then:** It builds and validates the Plan in the runner and compiles it with the workflow's task schemas

**Scenario:** _Compatibility remains intact_

- **Given:** A module exports an existing Plan or Plan factory
- **When:** The runner loads it
- **Then:** Existing loading and validation behavior still succeeds

**Scenario:** _Private boundaries remain private_

- **Given:** An authored workflow runs
- **When:** IPC messages and core exports are inspected
- **Then:** Neither contains runtime objects, task callbacks, schemas, or executor state

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.seqlane-plan-ir-and-typed-dataflow — Use a Seqlane-Owned Plan IR with Typed Dataflow](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
- [spec.seqlane-plan-ir-typed-dataflow — Seqlane Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)

## Traceability

- [spec.seqlane-plan-ir-typed-dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)
