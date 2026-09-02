# TS-020-36 — Acquire Locks in Global Order

**Status:** completed

## User outcome

As a runtime maintainer, admission cannot deadlock from inconsistent lock
acquisition order.

## Scope

- Acquire workspace locks before session locks.
- Enforce that order in the admission implementation.

## Out of scope

- Lock queue fairness and starvation policy.

## Implementation notes

Keep one acquisition function so no executor path can reverse the order. Tests
use crossed resource requests to prove no wait cycle forms.

## Acceptance criteria

**Scenario:** *Two invocations need the same resources*

- **Given:** Concurrent admission requests with shared workspace and session
- **When:** The runtime acquires locks
- **Then:** Both requests use workspace before session order

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
