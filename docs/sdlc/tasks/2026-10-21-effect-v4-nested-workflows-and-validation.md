---
id: task.effect-v4-nested-workflows-and-validation
title: Nested workflows, choices, repeats, and validation
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-sessions-and-workspace-admission
supersedes: []
---

# Nested workflows, choices, repeats, and validation

## Objective

Run a nested workflow containing choice, bounded repeat, next-input binding, and output validation through the CLI.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Run a nested workflow containing choice, bounded repeat, next-input binding, and output validation through the CLI.
- Preserve unselected-arm behavior, containment, per-attempt IDs, shared repeat budgets, validation order, and cancellation.
- Reuse domain validation and ordering; remove engine-specific envelopes rather than translating them into Effect envelopes.

## Affected areas

core Plan/DSL contract tests, `runtime/compile`, nested execution, invocation validation, and fixtures.

## Verification

existing choice/repeat/validation regressions pass through Effect, including invalid selected input and cancellation.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove replaced choice/repeat/compiler integration modules and fixtures after caller cutover.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-sessions-and-workspace-admission: prerequisite task](./2026-10-21-effect-v4-sessions-and-workspace-admission.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
