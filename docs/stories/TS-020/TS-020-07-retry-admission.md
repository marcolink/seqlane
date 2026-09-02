# TS-020-07 — Retain Admission Across Retries

**Status:** deferred (won't do for now)

## User outcome

As a workflow author, a retried task retains its original session and workspace
admission.

## Scope

- Add retry execution inside one invocation lifetime.
- Retain session and workspace locks across the retry chain.

## Decision

Do not implement automatic retries now. Retrying a mutating invocation needs an
explicit retry-safety policy; this ADR story does not define one. The runtime
continues to make one attempt per invocation.

## Out of scope

- Durable retry recovery across process restart.

## Implementation notes

Deliver this after session and workspace lifetime rules. Retry events retain the
same invocation identity and do not create a concurrent attempt.

## Acceptance criteria

**Scenario:** *An exclusive task retries*

- **Given:** An exclusive task that fails once and then succeeds
- **When:** The runtime retries the task
- **Then:** No other task acquires its session or workspace lock between attempts

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
