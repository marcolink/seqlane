---
id: task.effect-v4-sessions-and-workspace-admission
title: Sessions and workspace admission with real callers
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-dependency-graphs
supersedes: []
---

# Sessions and workspace admission with real callers

## Objective

Run generic adapter fixtures with isolated, shared, checkpoint, and fork behavior plus competing workspace users.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Run generic adapter fixtures with isolated, shared, checkpoint, and fork behavior plus competing workspace users.
- Reuse pure lowering rules; implement atomic eligibility and cancellation-aware waiting with Effect primitives.
- Preserve model inheritance, fairness, parent/child admission, background-process tracking, and uncertain-termination quarantine.

## Affected areas

`runtime/session`, `runtime/workspace`, `runtime/invocation`, `runtime/profile`, and `libs/adapter`.

## Verification

shared sessions serialize, compatible work overlaps, conflicts do not overlap, cancelled waiters unblock, and unconfirmed work retains ownership.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove replaced queue/lock/timer lifecycle code after all admission callers migrate.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-dependency-graphs: prerequisite task](./2026-10-21-effect-v4-dependency-graphs.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
