# TS-020-54 — Document Unmanaged-Process Limits

**Status:** completed

## User outcome

As a workflow author, I know the boundary of Seqlane workspace coordination.

## Scope

- Document that Seqlane coordinates only managed sessions and processes.
- State the risk from external unmanaged workspace activity.

## Out of scope

- Detection or control of external processes.

## Implementation notes

Update runtime and executor documentation. Do not claim that a workspace lock
coordinates processes that do not report to Seqlane.

## Acceptance criteria

**Scenario:** *A user uses the supported executor documentation*

- **Given:** The runtime and OpenCode documentation
- **When:** The user looks for workspace coordination guarantees
- **Then:** The documents state the unmanaged-process limitation

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
