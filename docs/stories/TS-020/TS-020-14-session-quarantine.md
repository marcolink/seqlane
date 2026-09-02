# TS-020-14 — Quarantine Unconfirmed Sessions

**Status:** completed

## User outcome

As a workflow author, a session with unconfirmed termination is not reused in a
Run.

## Scope

- Add quarantined session state.
- Reject or fail admission for a quarantined session.

## Out of scope

- Cross-Run session persistence.

## Implementation notes

Preserve the original termination cause. A quarantined session remains unusable
until the Run ends.

## Acceptance criteria

**Scenario:** *Termination cannot be confirmed*

- **Given:** A cancelled invocation without confirmation
- **When:** A later invocation resolves the same session
- **Then:** The runtime does not send a request to that session

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
