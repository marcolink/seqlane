---
id: task.execute-static-plans
title: Execute a static Plan through Seqlane-owned executor steps
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-integration
supersedes: []
---

# Execute a static Plan through Seqlane-owned executor steps

> Migrated from implementation story `TS-001-02`.

## Use Case
**As a** workflow author, **I want to** execute a validated Plan through the configured Seqlane executors, **so that** each task runs in the defined MVP order and contributes to the final workflow result.

## Acceptance Criteria
**Scenario:** *Validated Plan becomes an executable workflow*
- **Given:** A validated, deterministically ordered static Plan
- **When:** The runtime compiles the Plan
- **Then:** It creates one generated Mastra step per TaskNode, adds a synthetic Seqlane result step, and commits the workflow

**Scenario:** *Independent nodes run serially in the MVP*
- **Given:** A Plan contains independent TaskNodes
- **When:** The runtime executes the Plan
- **Then:** The MVP may run those nodes serially while preserving the original DAG in the Seqlane Plan

## Technical Details
Generated steps use a minimal internal envelope. Seqlane execution data is read from the internal `ExecutionContext`, which contains `runId`, `workflowInput`, `results`, `executors`, and the Seqlane event sink.

## Out of Scope
- Exposing Mastra workflow objects to workflow authors
- Parallel execution
- A separately deployed workflow service

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)

## Traceability

- [spec.mastra-runtime-integration](../specs/2026-09-02-mastra-runtime-integration.md)
