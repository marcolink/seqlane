---
id: task.shared-reads
title: Admit Shared Workspace Policies
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Admit Shared Workspace Policies

> Migrated from implementation story `TS-020-30`.

## User outcome

As a workflow author, tasks declared `shared` may overlap in one workspace.

## Scope

- Integrate shared workspace policy with invocation admission.
- Prove concurrent execution with separate sessions.

## Out of scope

- Runtime permission enforcement.

## Implementation notes

`shared` is an author assertion about scheduling safety. It does not imply that
the runtime, shell, tools, or filesystem are read-only.

## Acceptance criteria

**Scenario:** *Two shared tasks have separate sessions*

- **Given:** Two ready `shared` invocations for one workspace
- **When:** Both pass session admission
- **Then:** Both acquire workspace admission and may execute concurrently

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
