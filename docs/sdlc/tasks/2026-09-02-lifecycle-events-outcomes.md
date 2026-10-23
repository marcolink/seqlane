---
id: task.lifecycle-events-outcomes
title: Expose Seqlane-owned lifecycle events and outcomes
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Expose Seqlane-owned lifecycle events and outcomes

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-04`.

## Use Case

**As a** workflow operator, **I want to** receive Seqlane-owned lifecycle events and normalized run outcomes, **so that** I can observe execution without depending on runtime-engine types or streams.

## Acceptance Criteria

**Scenario:** _Invocation lifecycle is observable_

- **Given:** A Seqlane invocation starts, succeeds, or fails
- **When:** The corresponding invocation transition occurs
- **Then:** The runtime emits the appropriate Seqlane event through the canonical event sink with the run and invocation identity

**Scenario:** _Runtime outcomes remain Seqlane-owned_

- **Given:** A compiled workflow completes successfully or fails
- **When:** The runtime maps the result
- **Then:** Success returns the Seqlane workflow result and failure returns a normalized Seqlane error without exposing a runtime-engine result type

## Technical Details

The event sink emits Seqlane events such as `invocation.started`, `invocation.succeeded`, and `invocation.failed`. Errors are normalized into Seqlane categories including `InputValidationError`, `ExecutorError`, `OutputValidationError`, and `RuntimeError`.

## Out of Scope

- Exposing private runtime streams or telemetry types through the public protocol
- Adding an inspection application

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
