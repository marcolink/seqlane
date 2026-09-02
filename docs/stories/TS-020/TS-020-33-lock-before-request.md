# TS-020-33 — Lock Workspace Before the First Request

**Status:** completed

## User outcome

As a workflow author, Seqlane obtains workspace admission before executor work
starts.

## Scope

- Acquire workspace lock before `OpenCodeRun.prompt`.
- Cover the initial request path. Retry admission remains in TS-020-07 because
  the runtime does not yet execute retries.

## Out of scope

- Session lock ordering.

## Implementation notes

Use an adapter test double that records lock and prompt ordering. A late lock
acquisition is an error even if no conflict occurs in the test.

## Acceptance criteria

**Scenario:** *An exclusive task starts*

- **Given:** An exclusive invocation with a resolved workspace
- **When:** The executor receives its first request
- **Then:** Workspace admission was already acquired

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
