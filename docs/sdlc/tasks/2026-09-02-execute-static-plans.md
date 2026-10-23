---
id: task.execute-static-plans
title: Execute a static Plan through Seqlane-owned executor steps
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Execute a static Plan through Seqlane-owned executor steps

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-02`.

## Use Case

**As a** workflow author, **I want to** execute a validated Plan through the configured Seqlane executors, **so that** each task follows its dependencies and contributes to the final workflow result.

## Acceptance Criteria

**Scenario:** _Validated Plan becomes an executable workflow_

- **Given:** A validated, deterministically ordered static Plan
- **When:** The runtime compiles the Plan
- **Then:** Each task invocation executes through the Seqlane boundary, and the workflow result resolves from validated task outputs

**Scenario:** _Independent nodes run serially in the MVP_

- **Given:** A Plan contains independent TaskNodes
- **When:** The runtime executes the Plan
- **Then:** The MVP may run those nodes serially while preserving the original DAG in the Seqlane Plan

## Technical Details

The original slice executed static Plans and resolved workflow output behind a private runtime boundary. Its serial MVP policy is historical.

Current [Plan semantics](../specs/2026-10-21-effect-v4-execution-and-operations.md#requirement-plan-semantics) require dependency concurrency. This record does not require serial execution today.

## Out of Scope

- Exposing runtime objects to workflow authors
- Parallel execution
- A separately deployed workflow service

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
