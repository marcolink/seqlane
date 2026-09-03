---
id: task.write-exclusivity
title: Preserve Exclusive Admission
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Preserve Exclusive Admission

> Migrated from implementation story `TS-020-42`.

## User outcome

As a workflow author, exclusive admission never allows concurrent workspace
work.

## Scope

- Keep workspace admission independent from runtime permissions.
- Test multiple exclusive sessions against one workspace resource.

## Out of scope

- Automatic repair or rollback after conflict.

## Implementation notes

Seqlane reports admission state. Exclusive policy still serializes conflicting
work.

## Acceptance criteria

**Scenario:** *Two exclusive invocations target one workspace*

- **Given:** Two exclusive invocations with separate sessions
- **When:** Both invocations become ready
- **Then:** Only one invocation becomes active

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
