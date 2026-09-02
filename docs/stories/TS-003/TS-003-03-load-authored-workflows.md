# TS-003-03 — Load authored workflows in the runtime

**Status:** completed

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

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-003 — Use a Seqlane-Owned Plan IR with Typed Dataflow](../../ADR-003-seqlane-plan-ir-and-typed-dataflow.md)
- [TS-003 — Seqlane Plan IR and Typed Dataflow](../../TS-003-seqlane-plan-ir-typed-dataflow.md)
