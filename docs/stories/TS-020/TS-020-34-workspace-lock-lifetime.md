# TS-020-34 — Retain Workspace Lock for Invocation Effects

**Status:** completed

## User outcome

As a workflow author, a workspace lock remains held until all invocation
effects stop.

## Scope

- Connect lock release to reported activity and registered effect termination.
- Provide the common lifetime primitive that retries, child work, and tracked
  processes must register with when those execution paths are added.

## Out of scope

- Unmanaged external processes.
- Creating retry, child-work, and process execution paths.

## Implementation notes

Reuse the activity lifetime from session admission. The workspace lock cannot
release when the initial executor response completes.

## Acceptance criteria

**Scenario:** *An exclusive response starts a tracked process*

- **Given:** An exclusive invocation with a running tracked process
- **When:** Its initial response completes
- **Then:** Another workspace request remains waiting

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
