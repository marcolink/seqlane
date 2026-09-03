---
id: task.writer-blocking
title: Block Shared Admission Behind Exclusive Work
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Block Shared Admission Behind Exclusive Work

> Migrated from implementation story `TS-020-32`.

## User outcome

As a workflow author, a `shared` task waits while an `exclusive` task is
running in the same workspace resource.

## Scope

- Block shared admission while exclusive admission is active.
- Release queued work after exclusive work ends.

## Out of scope

- Claims about what runtime tools can modify.

## Implementation notes

The runtime does not inspect task prompts, commands, tools, or permissions to
validate the policy declaration.

## Acceptance criteria

**Scenario:** *A shared invocation waits behind an exclusive invocation*

- **Given:** An active `exclusive` workspace admission
- **When:** A `shared` invocation becomes dependency-ready
- **Then:** It does not execute before exclusive admission is released

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
