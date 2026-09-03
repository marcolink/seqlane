---
id: task.load-authored-workflows
title: Load authored workflows in the runtime
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.seqlane-plan-ir-typed-dataflow
supersedes: []
---

# Load authored workflows in the runtime

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
- Exposing runtime or Mastra types from core.
- Replacing the existing executor seam or implementing OpenCode transport.

## Implementation Notes

The runner still imports the selected module itself. It keeps the workflow definition, schema registry, executor registry, and compiled runtime state inside the child. Only existing Seqlane-owned JSON protocol messages cross to the CLI. Runtime binding resolution remains authoritative for Plan execution.

## Acceptance Criteria

**Scenario:** *Authored workflow builds in the child*
- **Given:** A runner receives a reference to a module exporting a workflow definition
- **When:** It loads the module
- **Then:** It builds and validates the Plan in the runner and compiles it with the workflow's task schemas

**Scenario:** *Compatibility remains intact*
- **Given:** A module exports an existing Plan or Plan factory
- **When:** The runner loads it
- **Then:** Existing loading and validation behavior still succeeds

**Scenario:** *Private boundaries remain private*
- **Given:** An authored workflow runs
- **When:** IPC messages and core exports are inspected
- **Then:** Neither contains Mastra objects, task callbacks, schemas, or executor state

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.seqlane-plan-ir-and-typed-dataflow — Use a Seqlane-Owned Plan IR with Typed Dataflow](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
- [spec.seqlane-plan-ir-typed-dataflow — Seqlane Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)

## Traceability

- [spec.seqlane-plan-ir-typed-dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)
