---
id: task.stop-failures-without-retries
title: Stop failed workflows without automatic retries
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Stop failed workflows without automatic retries

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-05`.

## Use Case

**As a** workflow operator, **I want to** stop downstream execution when a task fails without silently retrying it, **so that** failures and side effects remain deterministic in the MVP.

## Acceptance Criteria

**Scenario:** _Failure stops downstream execution_

- **Given:** A workflow contains an ordered chain where an upstream invocation fails
- **When:** The runtime normalizes that failure
- **Then:** Downstream invocations do not execute and the run fails with a Seqlane error

**Scenario:** _Failed invocation is attempted once_

- **Given:** An invocation encounters an executor failure
- **When:** The invocation exits
- **Then:** The runtime performs one executor attempt and does not retry side effects automatically

## Technical Details

Seqlane normalizes invocation failures and owns retry safety. The original MVP slice disabled automatic invocation retries. Current classifier transport retry policy has a separate owner.

## Out of Scope

- Effect-aware retry semantics
- Backoff or retry configuration
- Durable execution after failure

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
