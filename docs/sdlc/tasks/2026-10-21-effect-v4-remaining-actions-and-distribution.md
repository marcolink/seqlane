---
id: task.effect-v4-remaining-actions-and-distribution
title: Remaining Actions and distribution
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-hosted-history-and-inspection
supersedes: []
---

# Remaining Actions and distribution

## Objective

Migrate all service Actions and setup operations through Effect-backed lifecycle helpers with actual entry/post consumers.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Migrate all service Actions and setup operations through Effect-backed lifecycle helpers with actual entry/post consumers.
- Preserve Actions SDK inputs/outputs, saved ownership state, readiness, bounded shutdown, and exact publication confirmation.
- Keep review/publication transformations pure and retain their existing byte and identity bounds.

## Affected areas

all six `actions/*` packages and all three `libs/action-*` packages.

## Verification

entry/post lifecycle tests, service startup failure, cancellation, foreign-process survival, review/conflict fixtures, and rebuilt bundle execution.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove obsolete service loops, forwarding comments, build externals, and transitive integration-only dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-hosted-history-and-inspection: prerequisite task](./2026-10-21-effect-v4-hosted-history-and-inspection.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
