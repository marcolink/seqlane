---
id: task.preserve-input-output
title: Preserve Seqlane input and output semantics across execution
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Preserve Seqlane input and output semantics across execution

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-03`.

## Use Case

**As a** task author, **I want to** use Seqlane bindings and schemas for task data, **so that** each executor receives validated input and produces a validated result independent of runtime state.

## Acceptance Criteria

**Scenario:** _Task input is resolved and validated_

- **Given:** A TaskNode contains input bindings that reference workflow input or a prior invocation result
- **When:** The invocation starts
- **Then:** Seqlane resolves the bindings, traverses the referenced path, and validates the resulting input with the Seqlane task schema before invoking the executor

**Scenario:** _Task output is validated and retained_

- **Given:** An executor returns a raw output for a TaskNode
- **When:** The invocation completes
- **Then:** Seqlane validates the output and retains the validated result under the invocation ID

## Technical Details

Seqlane owns binding resolution and validated invocation results. Plan-node addresses remain separate from runtime invocation identities. The current [workflow contract](../specs/2026-10-22-workflow-execution-semantics.md#req-runtime-001-compile-behind-a-private-boundary) owns their representation.

## Out of Scope

- Exposing runtime state as the task output or binding contract
- Changing the public Seqlane Plan or `ValueRef` model
- Persisting private execution state

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
