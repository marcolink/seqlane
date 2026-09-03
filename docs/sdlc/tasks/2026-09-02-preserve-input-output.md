---
id: task.preserve-input-output
title: Preserve Seqlane input and output semantics across execution
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-integration
supersedes: []
---

# Preserve Seqlane input and output semantics across execution

> Migrated from implementation story `TS-001-03`.

## Use Case
**As a** task author, **I want to** use Seqlane bindings and schemas for task data, **so that** each executor receives validated input and produces a validated result independent of Mastra state.

## Acceptance Criteria
**Scenario:** *Task input is resolved and validated*
- **Given:** A TaskNode contains input bindings that reference workflow input or a prior invocation result
- **When:** Its generated step executes
- **Then:** Seqlane resolves the bindings, traverses the referenced path, and validates the resulting input with the Seqlane task schema before invoking the executor

**Scenario:** *Task output is validated and retained*
- **Given:** An executor returns a raw output for a TaskNode
- **When:** The generated step completes
- **Then:** Seqlane validates the output and stores it in `ExecutionContext.results` under the invocation ID

## Technical Details
Binding resolution is Seqlane-owned. A reference has the conceptual shape `{ type: "ref", invocationId, path }`; Mastra does not interpret `ValueRef` or carry semantic Seqlane values between steps.

## Out of Scope
- Using Mastra workflow state for task outputs or bindings
- Changing the public Seqlane Plan or `ValueRef` model
- Persisting `ExecutionContext`

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)

## Traceability

- [spec.mastra-runtime-integration](../specs/2026-09-02-mastra-runtime-integration.md)
