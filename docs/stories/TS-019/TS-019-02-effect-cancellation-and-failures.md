# TS-019-02 — Preserve Cancellation and Failure Outcomes

**Status:** completed

## User outcome

As a workflow user, I receive the existing cancelled or failed result when an
Effect-backed run stops or a step fails.

## Scope

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

Use Effect interruption state, not error-message text. Map errors at the
private runtime boundary. The runner owns its outer cancellation controller;
the active run must remain compatible with that controller.

## Acceptance criteria

**Scenario:** *Cancellation occurs before start*

- **Given:** A compiled Plan that has not started
- **When:** The caller cancels its run
- **Then:** The run reports the existing cancelled outcome
- **And:** No node executes

**Scenario:** *Cancellation reaches an executor*

- **Given:** An executor that observes its `AbortSignal`
- **When:** The caller cancels the active run
- **Then:** The executor signal becomes aborted
- **And:** The run emits one `run.cancelled` event
- **And:** The run does not emit `run.failed`

**Scenario:** *A step fails*

- **Given:** A Plan with a failing executor, output, or validation gate
- **When:** The runtime runs the Plan
- **Then:** Downstream nodes do not execute
- **And:** The existing Seqlane error retains the original cause

## Source

- [ADR-019](../../ADR-019-effect-private-runtime-engine.md)
- [TS-019](../../TS-019-effect-runtime-integration.md)
