# TS-020-11 — Reject Requests to Busy Sessions

**Status:** completed

## User outcome

As a runtime maintainer, Seqlane never sends a second request to a busy
OpenCode session.

## Scope

- Preserve the adapter prompt queue behavior.
- Add an observable regression test for the compliant baseline rule.

## Out of scope

- Invocation-lifetime lock release policy.

## Implementation notes

This rule is compliant at baseline. The story adds coverage that two prompt
calls serialize at the executor boundary.

## Acceptance criteria

**Scenario:** *A session has a pending prompt*

- **Given:** One prompt that has not completed
- **When:** A second prompt starts
- **Then:** The adapter sends the second request after the first completes

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
