---
id: task.session-quarantine
title: Quarantine Unconfirmed Sessions
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Quarantine Unconfirmed Sessions

> Migrated from implementation story `TS-020-14`.

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

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
