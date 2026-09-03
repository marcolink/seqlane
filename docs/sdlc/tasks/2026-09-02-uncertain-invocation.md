---
id: task.uncertain-invocation
title: Retain Uncertain Invocations as Active
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Retain Uncertain Invocations as Active

> Migrated from implementation story `TS-020-53`.

## User outcome

As a workflow author, a timed-out or disconnected task remains potentially
active until termination is confirmed.

## Scope

- Model timeout and disconnect as uncertain activity.
- Retain session and workspace locks until confirmation or quarantine.

## Out of scope

- Remote Run recovery after process restart.

## Implementation notes

Use the same state as unconfirmed cancellation. Do not mark an uncertain task
as complete or release resources from timeout alone.

## Acceptance criteria

**Scenario:** *An executor disconnects during exclusive work*

- **Given:** An exclusive invocation with no termination confirmation
- **When:** The runtime handles the disconnect
- **Then:** A competing invocation cannot receive its locks

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
