# TS-020-45 — Track or Prohibit Mutating Background Processes

**Status:** completed

## User outcome

As a workflow author, a mutating background process remains tracked or the
executor prohibits it.

## Scope

- Classify mutating background process requests.
- Track their lifecycle or reject unsupported background execution.

## Out of scope

- Coordination of processes external to Seqlane.

## Implementation notes

Fail closed when the adapter cannot report process termination. The workspace
lock remains held while a tracked process runs.

## Acceptance criteria

**Scenario:** *An exclusive task starts a background formatter*

- **Given:** A mutating background process request
- **When:** The adapter cannot track its lifetime
- **Then:** Seqlane rejects the request

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
