# TS-020-04 — Schedule Admitted Independent Work Concurrently

**Status:** completed

## User outcome

As a workflow author, unrelated tasks can run together when their session and
workspace admission permits it.

## Scope

- Add dependency-aware concurrent scheduling.
- Start only ready invocations that have passed admission.

## Out of scope

- Retry policy and durable execution.

## Implementation notes

Deliver this after session and workspace locks exist. Preserve dependency
failure gating and deterministic event identity.

## Acceptance criteria

**Scenario:** *Two admitted tasks are independent*

- **Given:** Two ready tasks with separate sessions and compatible reads
- **When:** The scheduler starts the Plan
- **Then:** Both tasks become active before either task completes

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
