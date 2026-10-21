---
id: task.effect-v4-nested-workflows-and-validation
title: Nested workflows, choices, repeats, and validation
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
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
- Share run limits and admission state across nesting. Reserve each container resource at the strongest required descendant policy before child execution.

## Affected areas

core Plan/DSL contract tests, `runtime/compile`, nested execution, invocation validation, and fixtures.

## Verification

existing choice/repeat/validation regressions pass through Effect, including invalid selected input and cancellation.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove replaced choice/repeat/compiler integration modules and fixtures after caller cutover.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Completed native nested workflows, selected choices, bounded repeats, next-input binding, and task or workflow output validation. Input defaults and transforms run once. False-like values and payloads with an `output` key retain their meaning. Unselected arms do not parse input, resolve sessions, start work, or validate output.

Nested graphs share eight body permits, one 1,000-attempt repeat budget, admission registries, and invocation creation order. Per-resource subtree reservations preserve compatible overlap and serialize conflicting siblings. Each repeat attempt has its own identity, parent containment, static dependencies, previous-attempt dependency, and session lineage. Validation releases the body permit and workspace before evaluator execution, while retaining the session through checkpoint settlement.

The full repository gate passes frozen install, documentation validation, 481 test mappings, typecheck, tests across 20 projects, lint, build, formatting, Nx sync, and diff checks. All 546 runtime tests and all 79 compiled Oclif end-to-end tests pass. The native caller regressions cover child defaults, three-level containment, shared limits, choice capability and model preflight, reuse and fork behavior, failure metrics, and cleanup before terminal publication. Three old five-second tests timed out in the first concurrent gate; each passed alone with unchanged budgets, then the complete gate passed.

Removed the old workspace-resource integration helper and moved its pure policy into the neutral workspace package. Ported the choice cancellation regression to the native caller. Legacy compiler and Promise caller bridges remain until production cutover at S9. Native adapter settlement and deadline limits remain owned by S5 and S7.

Structural review identified larger private orchestration and admission functions plus duplicated fixture helpers. Repeat attempt execution and deferred completion publication have separate cohesive modules. The remaining rows reflect domain policy, temporary legacy callers, and local test barriers; no zero-debt claim is made.

## Documentation impact

Classification: contract change

- PRD: no change
- RFC: no change
- SPEC: update `spec.effect-v4-execution-and-operations` with the private container reservation and ancestor ownership rules.
- TASK: update this task with nested admission and shared-limit verification.
- ADR required: no

### Rationale

A scalar parent owner allows exclusive sibling tasks to overlap. Shared parent reservations can also deadlock when both parents need exclusive children. Per-resource descendant reservations and distinct owners preserve child policies and prevent those failures. This clarifies the private execution contract without changing public authoring or wire schemas.

### Required work

Update the target spec before completing native admission. Verify nested callers, then reconcile this task, the runtime README, and migration delivery records.

### Open questions

None.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit, after S3 commit `f850ac4`. Evidence is branch-local. No default-branch or remote-CI delivery claim is made.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-sessions-and-workspace-admission: prerequisite task](./2026-10-21-effect-v4-sessions-and-workspace-admission.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
