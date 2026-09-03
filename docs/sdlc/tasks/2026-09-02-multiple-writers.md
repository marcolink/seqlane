---
id: task.multiple-writers
title: Serialize Multiple Exclusive Invocations
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Serialize Multiple Exclusive Invocations

> Migrated from implementation story `TS-020-40`.

## User outcome

As a workflow author, multiple `exclusive` invocations are valid and execute
one at a time for a workspace resource.

## Scope

- Serialize exclusive workspace admission.
- Remove multiple-writer diagnostics.

## Out of scope

- Runtime permission analysis.

## Implementation notes

Seqlane reports admission state, not inferred writer risk or permission
decisions.

## Acceptance criteria

**Scenario:** *Two exclusive invocations become ready*

- **Given:** Two ready `exclusive` invocations for one workspace resource
- **When:** They request admission
- **Then:** One runs and the other waits without a writer diagnostic

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
