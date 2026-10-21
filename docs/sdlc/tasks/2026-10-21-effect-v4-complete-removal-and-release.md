---
id: task.effect-v4-complete-removal-and-release
title: Complete removal and release gate
status: planned
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-remaining-actions-and-distribution
supersedes: []
---

# Complete removal and release gate

## Objective

Transfer retained requirements into target-only documents and replace legacy IDs in all relationships.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Transfer retained requirements into target-only documents and replace legacy IDs in all relationships.
- Remove obsolete engine documents and tracked skills after content transfer.
- Rewrite this plan and the proposal into target-only records, or remove them after retained contracts have canonical owners.
- Update every README, example, AGENTS instruction, CI rule, manifest, Nx target, release script, and generated asset.
- Audit tracked contents and filenames case-insensitively, with no documentation or test exceptions.
- Construct the audit pattern without retaining the old name as a literal in the final guard.
- Regenerate the lockfile, rebuild from clean outputs, and inspect declarations, sourcemaps, Action bundles, and packed npm packages.
- An empty source search alone does not prove that dependencies or bundles are clean.
- Record code/dependency/bundle deltas and reachable delivery commits or merged PR evidence.
- Do not mark complete while required remote CI is pending.

## Affected areas

The implementation files identified from the current source during this slice.

## Verification

complete verification matrix, all 23 package dispositions, no old runtime or dependency closure, and reviewed behavior-change documentation.

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
- [task.effect-v4-remaining-actions-and-distribution: prerequisite task](./2026-10-21-effect-v4-remaining-actions-and-distribution.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
