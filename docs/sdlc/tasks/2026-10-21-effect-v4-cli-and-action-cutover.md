---
id: task.effect-v4-cli-and-action-cutover
title: CLI and direct Action cutover
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-telemetry-and-event-pressure
supersedes: []
---

# CLI and direct Action cutover

## Objective

Make the common Effect program the sole execution path for `run`, `startWorkflowRun`, workflow packages, and Action workflow callers.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Make the common Effect program the sole execution path for `run`, `startWorkflowRun`, workflow packages, and Action workflow callers.
- Migrate plan/replay orchestration while preserving their contracts.
- Remove temporary test composition, runtime selectors, old direct entrypoints, duplicate cancellation handlers, and compatibility bridges.
- This slice can ship only after S1–S8 establish parity. Hosted callers still require S10 before final engine deletion.

## Affected areas

`apps/cli`, `libs/runtime` exports, both workflow Action libraries, and all three `workflows/*` packages.

## Verification

compiled CLI outside the checkout, input/import/output matrix, direct Action integration, no standalone disk state, and public Zod/API parity.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove the old engine-specific path after its callers migrate.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-telemetry-and-event-pressure: prerequisite task](./2026-10-21-effect-v4-telemetry-and-event-pressure.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
