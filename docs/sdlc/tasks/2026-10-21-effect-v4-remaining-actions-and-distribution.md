---
id: task.effect-v4-remaining-actions-and-distribution
title: Remaining Actions and distribution
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
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

## Documentation impact

Classification: contract change within the accepted migration.

- PRD and RFC: no requirement change; update delivery evidence after verification.
- SPEC: clarify Action entry/post ownership, validated handoff, native deadlines, and production-only distributions.
- TASK: this task owns all six Actions, three Action libraries, bundle loading, and package contents.
- Nearby docs: update Action and library READMEs for lifecycle and distribution changes.
- ADR required: no. The accepted migration already owns application lifetimes and package-wide cutover.

### Bounded delivery plan

1. Replace shared service timers and unchecked ownership data with native Effect programs and canonical Zod schemas. Preserve anchored service and sentinel ownership through actual main/post consumers.
2. Migrate the OpenCode, zvec-grep, and Ripwire service Actions. Readiness, startup cleanup, adoption, and post cleanup have finite native deadlines. Save validated ownership before transferring it to post.
3. Migrate setup and review/conflict Action composition roots and remaining I/O. Keep pure policy and publication fitting pure. Preserve exact publication identity, confirmation, byte limits, and explicit commit/push controls.
4. Keep `effect@4.0.5`. Snyk reports no direct vulnerabilities. Upgrade workspace Zod pins from `4.5.4` to `4.6.6`, the smallest listed fix for its direct resource-allocation vulnerability. Keep Zod as the public/wire contract owner.
5. Rebuild main/post and resident assets atomically. Exclude development runners, crash fixtures, and private test support from release tarballs. Prove installed production consumption outside the checkout.
6. Verify source, real temporary Git/process behavior, rebuilt bundles, and local `uses:` entrypoints on a trusted hosted runner without model prompts or real publication writes. Review all acceptance criteria, run full gates, reconcile docs, and commit only S11.

### Ownership and sequencing

Fresh implementation sessions separately own the shared service library, the three service Actions, and setup/review/conflict Actions with their two libraries. Root owns package distribution, workflow verification, lock installation, acceptance, documentation reconciliation, and Git. Coordinate shared lifecycle exports before updating their consumers. Freeze all writers before repository gates or distribution execution.

## Verification

entry/post lifecycle tests, service startup failure, cancellation, foreign-process survival, review/conflict fixtures, and rebuilt bundle execution.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove obsolete service loops, forwarding comments, build externals, and transitive integration-only dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Completed on `feat/effect-v4-migration`. Full local checks and trusted hosted verification pass.

- All six Actions and three Action libraries use scoped Effect composition at their application boundaries. Service main/post ownership uses validated Zod state, adoption acknowledgement, verified process identity, and finite readiness/cleanup bounds.
- Git, archive extraction, OpenCode, and Docker resources settle before temporary workspace removal. Unconfirmed cleanup retains owned files and reports failure. Publication preserves byte limits, run identity, and exact readback confirmation.
- Action bundles replace main, post, and resident assets together after successful compilation. Eight production tarballs exclude development runners and private fixtures. Installed consumption runs outside the checkout.
- Real child-process and Git fixtures, compiled main/post service checks, and an isolated installed consumer have passed focused verification. The full frozen-install, documentation, mapping, typecheck, test, lint, build, formatting, Nx synchronization, and whitespace gates pass. Compiled CLI verification passes: 116 tests pass and one duplicate Codex trace case is skipped. All eight installed tarballs resolve outside the checkout; direct and CLI runs preserve `false` and emit canonical events. Rebuilt main/post checks prove all three residents survive main, stop after post, and leave a foreign process alive. The compiled review and resolver fixtures also pass with zero model requests, GET-only Action requests, denied publication writes, and unchanged Git state. [Hosted CI](https://github.com/marcolink/seqlane/actions/runs/39744581106) passes for executable source commit `b6c1d1e734a1369930d81115b946c78e5f0fff6b`: all six actual `uses:` entrypoints, saved-state post cleanup, Linux process ownership, production package consumption, and quality gates pass. Publication is skipped by the feature-branch guard. Only documentation reconciliation follows this verified source snapshot in this task commit.

The existing Docker daemon is available, but the pinned image is not cached. Real image execution was not performed. Real subprocess fixtures cover delayed daemon creation, cancellation, output bounds, foreign identity, and uncertain cleanup.

The reviewed structural diagnostics identify deliberate private boundary parameters, native ownership state, workflow/lockfile size, and schema-shaped matches. The Git process boundary is extracted from porcelain policy. No quality baseline or blanket acknowledgement hides diagnostics.

## Delivery state

Completed in this task commit on the migration branch. Local repository, installed-package, compiled CLI, rebuilt Action, and trusted hosted CI gates pass. The verified executable source snapshot is linked above; this commit adds its documentation evidence. No main-branch merge or registry publication is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-hosted-history-and-inspection: prerequisite task](./2026-10-21-effect-v4-hosted-history-and-inspection.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
