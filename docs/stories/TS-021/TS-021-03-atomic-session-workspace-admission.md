# TS-021-03 — Admit Session and Workspace Resources Atomically

**Status:** completed

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

- [ADR-021](../../ADR-021-session-checkpoint-reuse-and-branching.md)
- [TS-021](../../TS-021-session-checkpoint-reuse-and-branching.md)
