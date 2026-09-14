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
- Replace a trusted old-version report with a fresh full-diff baseline,
  without carrying its findings, dispositions, or metrics.
- Select baseline or incremental scope from immutable Git revisions and
  the last published trusted checkpoint.
- Collect complete eligible paths and scoped patch evidence with literal Git
  arguments, exact checkpoint commit validation, typed batches, and hard
  cumulative Git, model, and time limits.
- Restrict review lanes to selected scope and gate new findings locally.
- Require each new finding's primary cause anchor to overlap the baseline
  PR change or the current checkpoint-to-head change. Older hunks in a
  newly edited file remain context only.
- Persist typed bounded finding evidence and location status. Keep finding
  identity separate from line position without requiring language parsers.
- Assemble one run-local manifest with a sealed item and lane denominator,
  explicit terminal outcomes, provenance, and independent status dimensions.
  Upload one verified final GitHub Actions artifact within a hard size bound.
- Preserve retained finding lifecycle, dispositions, and cumulative verdict.
- Publish one bounded summary and checkpoint together after live target,
  base, head, report, and checkpoint guards pass. Use the shared per-PR
  non-cancelling publication queue also used by mechanical dispositions.
- Show review mode, scope, and limitations in the human report.

## Out of scope

- A new public Seqlane workflow or runtime API.
- DynamoDB, external storage services, leases, journals, and IAM/OIDC
  coordinator access.
- Cross-run item resume, artifact compaction, and inline finding publication.
- Automatic baseline reset on force-push, retargeting, or state failure.

## Implementation plan

1. Extend the report-state schema, metadata marker, finding-ID parser, and
   reader. Coordinate v5 with the draft mechanical-disposition work so one
   version has one meaning.
2. Add a pure report-state classifier and scope selector for
   P(B,H) intersect D(C,H), then apply exclusions before finding admission.
   Test invalid current state, exact checkpoint objects, Git paths,
   non-ancestor commits, renames, deletions, base movement, and same-head runs.
3. Change Git evidence to use validated literal argv paths and produce a
   complete scoped patch or fail. Add typed batch plans and results,
   deterministic aggregation, bounded subprocesses, and cumulative budgets.
4. Pass scope and retained current-generation findings to history
   verification, configured lanes, and synthesis. Add the deterministic
   new-finding path and changed-anchor gate, first-observed revision, typed
   evidence and location status, evidence-backed identity, and typed
   comparison outcomes.
5. Preserve prior findings and compute a cumulative verdict. Skip discovery
   lanes for empty scope; still verify retained findings as required.
6. Add the Action-owned run-local manifest, sealed item and expected-lane
   denominator, one-to-one terminal outcomes, provenance and trusted rule
   validation. Bound final canonical bytes, upload one GitHub Actions
   artifact, verify its reference, and require it in v5 state. Give the
   publisher only the artifact-read and PR-comment-write permissions it needs;
   do not grant artifact or comment write access to review-target code.
7. Split review computation from final publication. Route all bot comment
   writers, including mechanical dispositions, through one per-PR
   non-cancelling GitHub Actions queue. Re-read live report and command
   ledger after queue admission. Publish one bounded authoritative summary
   only when the sealed run is complete and all guards pass. Reconcile an
   ambiguous response by exact readback without issuing a duplicate write.
8. Thread one typed ScopeIdentity through evidence, lanes, finalization,
   artifact, and publication. Re-read target branch, base revision, head,
   report identity, and checkpoint before the final write.
9. Update documentation and run focused, contract, and hosted workflow
   checks. Keep legacy v3 progress behavior clearly separate from v5.

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

- Run pnpm run test:mapping before focused tests.
- Run old-version replacement, malformed-input, schema-matrix, literal
  pathspec, exact-object, exclusion, typed-batch, aggregation, cumulative
  budget, finding-ID isolation, typed-evidence, comparison-outcome, rule-source,
  and workflow-admission tests.
- Prove every configured batch lane has a validated result before coverage
  can be complete; missing or failed lanes preserve the old checkpoint.
- Test a file edited twice: a candidate anchored only in the earlier PR
  hunk receives no new ID, while a candidate anchored in the C-to-H hunk
  can receive one. Cover added, removed, zero-hunk tree-entry, and no-change
  evidence; validate the cause locally before ID allocation.
- Test two baseline publishers and concurrent report updates in the same
  shared queue, disposition reconciliation, stale guards, queue overflow,
  ambiguous-write readback, and one final authoritative comment.
- Test byte-stable manifests, pre-upload size failure, one verified artifact,
  artifact expiry, and missing-reference refusal without a baseline reset.
- Run pnpm docs:index, pnpm docs:validate, formatting, and git diff --check.
- Run the hosted workflow on an open PR for a baseline, a changed-file
  follow-up, and a same-head follow-up. Inspect authoritative state and
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
