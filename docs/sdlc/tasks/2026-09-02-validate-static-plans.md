---
id: task.validate-static-plans
title: Make static plans deterministic before execution
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Make static plans deterministic before execution

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-01`.

## Use Case

**As a** workflow author, **I want to** have my static Plan validated and ordered deterministically, **so that** the same workflow executes predictably every time.

## Acceptance Criteria

**Scenario:** _Valid static Plan is prepared for execution_

- **Given:** A static Seqlane Plan contains valid TaskNodes and dependency relationships
- **When:** The runtime compiles the Plan
- **Then:** The Plan is validated and deterministically topologically sorted before execution

**Scenario:** _Invalid static Plan is rejected_

- **Given:** A static Seqlane Plan fails Plan validation
- **When:** The runtime attempts compilation
- **Then:** Compilation fails before task work starts

## Technical Details

Seqlane owns Plan validation and dependency meaning. The Seqlane Plan remains the authoritative representation of the dependency graph.

## Out of Scope

- Parallel Plan lowering
- Branch, loop, and foreach lowering
- Persisted workflow execution

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
