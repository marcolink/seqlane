---
id: task.runtime-checkpoint-lifecycle
title: Resolve and Publish Run-Local Session Checkpoints
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.session-checkpoint-reuse-and-branching
supersedes: []
---

# Resolve and Publish Run-Local Session Checkpoints

> Migrated from implementation story `TS-021-02`.

## User outcome

As a workflow author, reuse continues the exact parent session and branches
start from its stable checkpoint.

## Scope

- Add private session/checkpoint capabilities to resolver adapters.
- Publish checkpoints after complete invocation activity only.
- Eagerly materialize all declared branches before parent continuation starts.
- Enforce Run locality, compatibility, single-session execution, and poisoning.

## Out of scope

Atomic workspace admission and adapter-specific HTTP calls.

## Implementation notes

Branch materialization is a post-turn lifecycle operation, not a scheduler task
and does not wait on the source invocation lease.

## Acceptance criteria

**Scenario:** *Eager fan-out*

- **Given:** one source with two declared branches and one parent reuse
- **When:** the source completes
- **Then:** both child sessions exist before parent reuse can advance

**Scenario:** *Ambiguous source*

- **Given:** a source with timeout, disconnect, or unconfirmed cancellation
- **When:** a consumer needs its checkpoint
- **Then:** it fails with the causal poisoned-session error

## Source

- [adr.session-checkpoint-reuse-and-branching](../adrs/2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)

## Traceability

- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)
