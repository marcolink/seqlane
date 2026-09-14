---
id: task.incremental-pull-request-review-scope
title: Implement Incremental Pull Request Review Scope
status: planned
owners:
  - core
created: 2026-09-13
updated: 2026-09-14
upstream:
  - spec.incremental-pull-request-review-scope
supersedes: []
---

# Implement Incremental Pull Request Review Scope

## Objective

Make the first published PR review cover the full branch diff. Make later
reviews add findings only for PR files changed since the last published review.

## Upstream requirements

Implement [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md).
Preserve the state, lifecycle, trust, and publication rules in
[spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md).

## Scope

- Add strict scope-checkpoint state and a new finding-ID generation.
- Replace a trusted old-version report with a fresh full-diff baseline, without
  carrying its findings, dispositions, or metrics.
- Select baseline or incremental scope from immutable Git revisions and the
  last published trusted checkpoint.
- Collect complete eligible paths and scoped patch evidence with literal Git
  path arguments, exact checkpoint commit validation, typed batch contracts,
  and hard cumulative batch, model, and time limits.
- Restrict review lanes to the selected scope and gate new findings locally
  before stable-ID allocation.
- Require canonical location-independent candidate identity and bounded
  evidence-backed positioning.
- Persist a bounded, integrity-checked run manifest as a trusted workflow
  artifact with explicit item outcomes, provenance, and independent status
  dimensions.
- Define typed comparison outcomes and the canonical publication state machine,
  including idempotent retries and visible fallback for unpublishable findings.
- Preserve retained finding lifecycle, dispositions, and cumulative verdict.
- Publish the report and checkpoint together only after the live target branch,
  base revision, head, and previous-checkpoint guards pass.
- Show review mode, scope, and limitations in the human report.

## Out of scope

- A new public Seqlane workflow or runtime API.
- A separate durable review database or patch archive.
- Automatic baseline reset on force-push, retargeting, or state failure.
- Changes to the existing GitHub admission and concurrency policy.

## Implementation plan

1. Extend the existing report-state schema, metadata marker, finding-ID parser,
   and reader. Coordinate the next outer schema revision with the draft
   mechanical-disposition work so one version has one meaning.
2. Add a pure report-state classifier and scope selector for
   `P(B,H) ∩ D(C,H)`, then apply exclusions before finding admission. Test
   invalid current state, exact checkpoint object validation, Git path records,
   non-ancestor commits, renames, deletions, base movement, and same-head runs.
3. Change Git evidence to use validated literal argv paths and produce a
   complete scoped patch or fail. Add typed batch plans/results, deterministic
   aggregation and deduplication, bounded subprocesses, and cumulative
   pre-model and model resource accounting.
4. Pass scope and prior current-generation findings to history verification,
   review lanes, and synthesis. Add the deterministic new-finding path gate
   and first-observed revision. Add canonical location-independent identity,
   versioned local evidence identities, evidence-backed positioning, and typed
   comparison outcomes. Verify continuity across presentation changes.
5. Preserve prior findings and compute a cumulative verdict in finalization.
   Skip discovery lanes for empty scope.
6. Add the Action-owned bounded manifest artifact, sealing and integrity checks,
   typed item outcomes with source reuse proofs, provenance and rule-source
   validation, and strict resume reuse. Require the sealed manifest reference
   in v5 state and implement the independent status enums and gate matrix.
7. Implement the canonical publication state machine. Reconcile uncertain
   summary and inline writes, route unpublishable findings to a visible
   fallback, and advance the checkpoint only after final publication. Persist
   publication intents and receipts in the separate publisher-owned journal;
   test crash recovery without mutating sealed execution snapshots.
8. Thread one typed scope identity through evidence, lanes, finalization, and
   publication. Re-read checkpoint and live target branch, base revision, and
   head at publication. Write the new checkpoint only with the completed
   report.
9. Update documentation and run focused, contract, and hosted workflow checks.

## Affected areas

- `libs/action-code-review/src/workflows/review-contracts.ts`
- `libs/action-code-review/src/workflows/review-history.ts`
- `libs/action-code-review/src/workflows/review-git-evidence.ts`
- `libs/action-code-review/src/workflows/review-workflow.ts`
- `libs/action-code-review/src/workflows/review-lanes.ts`
- `libs/action-code-review/src/workflows/review-synthesis.ts`
- `libs/action-code-review/src/workflows/review-finalization.ts`
- `libs/action-code-review/src/publication-*.ts`
- `libs/action-code-review/src/review-run.ts`
- `libs/action-code-review/README.md`
- `.github/workflows/seqlane-code-review.yml`

## Verification

- Run `pnpm run test:mapping` before focused tests.
- Run focused Action-library tests for the requirement and failure matrix in
  the specification.
- Run old-version replacement, malformed-input, schema-matrix, literal
  pathspec, exact-object, exclusion, typed-batch, aggregation, cumulative
  budget, publication-identity, finding-ID isolation, manifest lifecycle,
  evidence positioning, comparison outcome, rule-source, and workflow
  admission tests.
- Run `pnpm docs:index`, `pnpm docs:validate`, formatting, and `git diff
  --check`.
- Run the hosted workflow on an open PR for a baseline, a changed-file
  follow-up, and a same-head follow-up. Inspect the authoritative state and
  verify that unchanged-file findings receive no new ID.

## Completion criteria

- All acceptance criteria in the upstream spec are demonstrated by focused
  tests and the hosted run.
- A partial or failed run preserves the prior published checkpoint.
- Review output and report state do not claim a full-branch re-review on an
  incremental run.

## Outcome

Implementation pending.

## Delivery state

Planned. No implementation or target-branch delivery claim is made here.

## Traceability

- Contract: [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md)
- State and lifecycle: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
