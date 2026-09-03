---
id: task.atomic-session-workspace-admission
title: Admit Session and Workspace Resources Atomically
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.session-checkpoint-reuse-and-branching
supersedes: []
---

# Admit Session and Workspace Resources Atomically

> Migrated from implementation story `TS-021-03`.

## User outcome

As a workflow author, ready branches run concurrently only when both their
sessions and workspace policies permit it, without lock-order deadlocks.

## Scope

- Replace sequential resource acquisition with atomic joint admission.
- Retain FIFO/writer-preference workspace behavior.
- Prove branches overlap with shared workspace and serialize with exclusive.
- Prove waiting parent continuations reserve no resource.

## Out of scope

New workspace semantics, permission policies, or workspace snapshots.

## Implementation notes

No resource may remain held while another required resource is unavailable.
Subworkflow orchestration must release any lease before awaiting child work.

## Acceptance criteria

**Scenario:** *Crossed resources*

- **Given:** ready invocations with a free session/busy workspace and the
  inverse resource state
- **When:** admission runs
- **Then:** neither holds a partial lease and no deadlock occurs

**Scenario:** *Exclusive branch workspace*

- **Given:** two branch sessions target one exclusive workspace
- **When:** both become ready
- **Then:** one executes while the other waits

## Source

- [adr.session-checkpoint-reuse-and-branching](../adrs/2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)

## Traceability

- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)
