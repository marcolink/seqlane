---
id: task.extract-merge-conflict-action-composition
title: Extract merge-conflict Action composition
status: completed
owners:
  - core
created: 2026-10-23
updated: 2026-10-23
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-remaining-actions-and-distribution
supersedes: []
---

# Extract merge-conflict Action composition

## Objective

Fix approved finding `SEQ-PR180-003`: move concrete resolver port construction and runtime wiring out of the GitHub Actions entrypoint.

## Upstream requirements

The active execution specification requires thin Actions Toolkit adapters and native scoped execution. The scoped Action guide limits `main.ts` to input validation, context, signals, logging, outputs and failure handling. The existing private Action-specific resolver package owns reusable behavior.

## Documentation impact

Classification: implementation-only repair of the existing boundary. PRD, RFC, ADR and SPEC need no change. This task records the approved extraction. Clarify the composition boundary in the nearest resolver README. No public contract or policy changes are intended.

## Scope

Extract an Action-specific composition module. Pass parsed inputs, explicit context and narrow Toolkit callbacks into it. Keep GitHub SDK adaptation at the entrypoint. Preserve scoped resource ownership, unsafe-workspace retention, lazy agent construction, secret masking, exact publication identity and separate commit/push controls.

## Out of scope

Other review findings, CI payload policy, PR splitting, new dependencies, generic support libraries, public inputs or outputs, workflow behavior, registry publication and merge to next.

## Implementation plan

Move concrete Git, metadata, filesystem, lockfile, generated-file, agent and commit/push wiring into the composition module. Keep ordinary resolver behavior in the existing private package. Keep `main.ts` responsible for reading and validating inputs, wiring signals, invoking composition and publishing outputs or failures. Move resource orchestration with composition where necessary to keep that boundary clear. Preserve the shipped skill asset path and cause propagation.

## Affected areas

`actions/resolve-merge-conflicts/src/main.ts`, its composition module and existing tests, plus `libs/action-merge-conflict-resolution/README.md`.

## Verification

Run test mapping before tests. Verify existing real Git fixtures, lazy-agent cases, shipped skill lookup and built entrypoint smoke behavior. The clean-merge fixture must make no model call or remote mutation. Missing push credentials must fail before network access. Preserve cancellation, unsafe cleanup retention, outputs and failure diagnostics. Prefer behavioral assertions over tests tied to module layout.

Run scoped tests, types, lint, formatting, a fresh bundle and runtime-loading checks. Then run the complete repository gate. Record actual hosted `uses:` verification separately on the published head.

## Completion criteria

The entrypoint no longer constructs concrete runtime ports. The new module receives explicit inputs and context without Actions Toolkit globals. Public metadata and dependencies remain unchanged. All required local checks pass. One separate commit contains this approved extraction.

## Outcome

`composition.ts` now constructs resolver-specific ports and owns the temporary agent workspace. It receives parsed inputs, an existing GitHub metadata client, explicit context and narrow logging/summary callbacks. Small local helpers keep workspace lifetime, lazy files, agent startup and commit/push wiring readable. `main.ts` retains Toolkit input validation and masking, Octokit adaptation, signals, program evaluation, outputs and failure diagnostics.

The extraction preserves canonical workflow metadata validation, push-token redaction and recordings, lazy agent startup, cancellation checks, shared unsafe-workspace retention and separately controlled commit/push. The shipped skill path, public Action metadata and dependencies are unchanged. The nearest resolver README documents the boundary. This implementation matches the active specification; no upstream contract change or unresolved documentation drift remains.

Verification passed on Node 24.16.0: 625 mappings, 176 scoped Action/resolver tests with real subprocess access, final typecheck, a clean uncached Action bundle, and built entrypoint smoke tests. The clean merge fixture makes no remote writes or model call; missing push credentials fail before GitHub requests. ESLint and formatting pass. Generated bundles remain ignored. Quality diagnostics report no gating regressions; four type-only interfaces are reported as non-gating dead-code candidates despite their TypeScript references. The complete root gate passes, including frozen installation, 361 canonical documents, all project tests, lint, build, formatting, Nx sync and diff checks.

## Delivery state

Implemented and locally verified on `feat/effect-v4-migration` for [PR #180](https://github.com/marcolink/seqlane/pull/180), based on next. The containing task commit records the extraction. Published-head and actual hosted Action verification are tracked in the PR. This task has no functional dependency on the setup fix. No target-branch merge or publication is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md#requirement-action-lifetimes)
- [task.effect-v4-remaining-actions-and-distribution](./2026-10-21-effect-v4-remaining-actions-and-distribution.md)
- [PR #180 review report](https://github.com/marcolink/seqlane/pull/180#issuecomment-6374175581)
