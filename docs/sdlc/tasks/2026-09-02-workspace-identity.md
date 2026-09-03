---
id: task.workspace-identity
title: Resolve Canonical Workspace Identity
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Resolve Canonical Workspace Identity

> Migrated from implementation story `TS-020-27`.

## User outcome

As a runtime maintainer, every task invocation has one canonical workspace
identity for scheduling.

## Scope

- Resolve one runtime workspace identity before admission.
- Normalize equivalent checkout paths before resource lookup.
- Use a run-scoped fallback identity when the runtime does not provide a path.

## Out of scope

- Filesystem access enforcement.

## Implementation notes

Workspace identity selects an admission resource only. It does not grant,
remove, or validate runtime authority.

## Acceptance criteria

**Scenario:** *Two paths refer to one checkout*

- **Given:** Equivalent runtime workspace paths
- **When:** The runtime resolves identities
- **Then:** Both invocations use the same canonical admission resource

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
