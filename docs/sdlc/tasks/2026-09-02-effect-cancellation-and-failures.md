---
id: task.effect-cancellation-and-failures
title: Preserve Cancellation and Failure Outcomes
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Preserve Cancellation and Failure Outcomes

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-019-02`.

## User outcome

As a workflow user, I receive the existing cancelled or failed result when an
workflow run stops or an invocation fails.

## Historical scope

- Map Effect interruption to the existing cancelled run outcome.
- Preserve executor `AbortSignal` cancellation.
- Keep cancellation safe before start and on repeated calls.
- Preserve the original cause for executor, validation, and output failures.
- Emit one canonical `run.cancelled` event.
- Add parity tests for cancellation and failure scenarios.

## Out of scope

- Automatic retries, recovery, durable interruption, or new error contracts.
- Changes to runner control messages, Plan payloads, or event schemas.

## Implementation notes

The current [run program](../specs/2026-10-21-effect-v4-execution-and-operations.md#requirement-run-program) owns cancellation and final settlement. The [runner contract](../specs/2026-10-22-workflow-execution-semantics.md#req-runner-001-own-serialized-contracts-in-protocol) owns serialized cancellation outcomes.

These links record a later transfer. They do not establish historical Effect v4 delivery.

## Acceptance criteria

**Scenario:** _Cancellation occurs before start_

- **Given:** A compiled Plan that has not started
- **When:** The caller cancels its run
- **Then:** The run reports the existing cancelled outcome
- **And:** No node executes

**Scenario:** _Cancellation reaches an executor_

- **Given:** An executor that observes its `AbortSignal`
- **When:** The caller cancels the active run
- **Then:** The executor signal becomes aborted
- **And:** The run emits one `run.cancelled` event
- **And:** The run does not emit `run.failed`

**Scenario:** _A step fails_

- **Given:** A Plan with a failing executor, output, or validation gate
- **When:** The runtime runs the Plan
- **Then:** Downstream nodes do not execute
- **And:** The existing Seqlane error retains the original cause

## Source and current owners

- [adr.effect-private-runtime-engine](../adrs/2026-09-02-effect-private-runtime-engine.md)
- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)

## Traceability

- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)

- [spec.effect-v4-execution-and-operations: Current execution authority](../specs/2026-10-21-effect-v4-execution-and-operations.md)
