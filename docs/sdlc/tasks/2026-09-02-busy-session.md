---
id: task.busy-session
title: Reject Requests to Busy Sessions
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Reject Requests to Busy Sessions

> Migrated from implementation story `TS-020-11`.

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

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
