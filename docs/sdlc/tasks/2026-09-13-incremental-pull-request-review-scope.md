---
id: task.incremental-pull-request-review-scope
title: Implement Incremental Pull Request Review Scope
status: in-progress
owners:
  - core
created: 2026-09-13
updated: 2026-10-07
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
  without carrying its findings or metrics.
- Select baseline or incremental scope from immutable Git revisions and
  the last published trusted checkpoint.
- Collect complete eligible paths and scoped patch evidence with literal Git
  arguments, exact checkpoint commit validation, typed batches, and hard
  cumulative Git, model, and time limits.
- Restrict review lanes to selected scope and gate new findings locally.
- Require each new finding's primary cause anchor to overlap the baseline
  PR change or the current checkpoint-to-head change. Older hunks in a
  newly edited file remain context only. An incremental cause must also
  remain part of the current PR diff, not an imported target-branch edit.
- Persist typed bounded finding evidence and location status. Keep finding
  identity separate from line position without requiring language parsers.
- Assemble one run-local manifest with a sealed item and lane denominator,
  explicit terminal outcomes, provenance, and independent status dimensions.
  Upload one verified final GitHub Actions artifact within a hard size bound.
- Preserve retained finding lifecycle and cumulative verdict.
- Publish one bounded summary and checkpoint together after live target,
  base, head, report, and checkpoint guards pass. Use the shared per-PR
  non-cancelling publication queue.
- Show review mode, scope, and limitations in the human report.

## Out of scope

- A new public Seqlane workflow or runtime API.
- DynamoDB, external storage services, leases, journals, and IAM/OIDC
  coordinator access.
- Cross-run item resume, artifact compaction, and inline finding publication.
- Automatic baseline reset on force-push, retargeting, or state failure.

## Implementation plan

### First tracer bullet: private scope and complete Git evidence

Outcome: a trusted admission produces deterministic scope and complete evidence
through real Git. The current v4 workflow remains separate.

Path: strict ScopeIdentity -> bounded Git port -> pure selector -> grouped
literal scoped diffs -> review batches, local validation batches, and tree metadata.

Risk: path parsing, checkpoint identity, rebases, exclusions, or incomplete
output can silently widen scope or omit evidence.

Evidence: temporary Git repositories cover baseline, incremental, same-head,
rebase, reverted edits, base movement, renames, deletions, binary, mode,
symlink, submodule, and hostile-path cases. Port tests cover missing measurements,
truncation, cancellation, and resource boundaries.

This slice implements the collector against a strict trusted host port.
The revised host contract requires timeout, cancellation, complete output, and
measured wall time. CPU, memory, and transfer measurement are no longer required.
The original test adapter measured child resources; the simpler production
adapter replaces it for real-Git integration tests.

The collector seals complete local evidence before model work. Baseline review
uses the current PR diff. Incremental review uses the checkpoint-to-head diff.
Current-PR evidence stays in separate local validation batches. Each selected
revision range uses one bounded multi-path command, including at most 200
literal paths. Raw records and patch headers must exactly match that inventory.
Whole paths are batched locally. A single path patch above the batch limit
fails closed; hunk partitioning is follow-up work. Both batch groups share
the existing batch, hunk, byte, and execution ceilings.

Excluded from this slice: trusted v5 report classification and transport,
model invocation planning, finding admission, manifests, storage, and publication.
No existing finding or checkpoint changes during this slice.

### Remaining delivery

The private [trusted v5 report admission slice](./2026-09-14-unify-code-review-comment-state.md#next-pr-trusted-v5-report-admission)
is implemented locally on top of PR #176 at `7ce908b`.
It connects strict report classification to this collector. Model and publication
wiring remain pending.

1. Deliver the [production Git host slice](#next-pr-production-git-host-for-v5-admission)
   on top of PR #178. Connect the existing private admission path to native
   Git execution and exact-checkpoint fetch. Preserve report classification and
   scope semantics. The test fixture does not satisfy this production boundary.
2. Connect the verified host and admission output to the later v5 computation
   job. Keep the current v4 workflow separate until its replacement is complete.
3. Extend complete batching with deterministic hunk partitioning for paths
   that exceed one batch. Preserve literal paths, complete evidence, shared
   cumulative budgets, and separate review and validation batches.
4. Pass scope, the mode-selected review patch, and retained current-generation
   findings as reference context to configured lanes and synthesis. Send only
   retained findings whose primary causes have verified overlap with new
   changes to history verification. A changed file alone is insufficient. Keep
   current-PR validation batches local to the cause-admission gate. Add the deterministic
   new-finding path and changed-anchor gate, first-observed revision, typed
   evidence and location status, evidence-backed identity, and typed
   comparison outcomes. Reuse the canonical RetainedFinding and evidence schemas.
5. Seal the canonical current-head verification sources separately from the
   discovery denominator. Validate finding, head, path, digest, and location
   bindings before accepting an outcome; record it in the manifest.
   Preserve untouched findings as `not_reviewed` and compute a cumulative
   verdict. Empty scope skips all model work, including history verification
   and synthesis. Do not claim fresh verification for carried findings.
6. Add the Action-owned run-local manifest, sealed item and expected-lane
   denominator, one-to-one terminal outcomes, provenance and trusted rule
   validation. Apply the pinned redaction policy before both persistence sinks.
   Bound final canonical bytes, reserve storage under the canonical aggregate
   caps, upload one GitHub Actions artifact, and reconcile actual stored bytes.
   Validate the canonical ManifestReference and require it in v5 state.
7. Use separate computation, publisher, recovery inspection, and recovery
   dispatch jobs under the canonical publication permissions contract.
   Isolate model workers from GitHub and artifact runtime credentials.
   Register the publisher before queue entry. Route review publishers alone
   through the canonical non-cancelling per-PR queue. Re-read the live report
   and PR after admission. Block every later write while an earlier request
   has an unknown effect. Replay the existing sealed candidate only after
   proving no previous write can complete. Never upload a second manifest.
8. Thread one typed ScopeIdentity through evidence, lanes, finalization,
   artifact, and publication. Re-read target branch, base revision, head,
   report identity, and checkpoint before the final write.
9. Update documentation and run focused, contract, and hosted workflow
   checks. Keep current v4 progress and ledger behavior separate from planned v5.

### Next PR: production Git host for v5 admission

#### Stack and documentation impact

Base: [PR #178](https://github.com/marcolink/seqlane/pull/178), branch
`codex/trusted-review-admission`, at
`f897a641f510485187e384c13491fc8f41c5dc38`.
Merge order: #112 -> #176 -> #178 -> [PR #179](https://github.com/marcolink/seqlane/pull/179).
This slice is not independently mergeable into `main`.

Classification: contract change.

- PRD: no change. Incremental review behavior stays the same.
- RFC: no change. This is private Action integration.
- SPEC: update `requirement-complete-evidence` to use native Git with timeout, cancellation, and bounded output.
- TASK: update this plan and the linked trusted-admission task.
- ADR required: no. Existing trust, runtime, storage, and publication decisions remain unchanged.

The earlier host design added hard CPU, memory, and transfer controls without
an observed review failure. Its custom supervisor and transport cost more than
the evidence justified. The revised contract removes those requirements first.
The implementation then removes the corresponding code and runner setup.

#### Tracer bullet: real admission through native Git

- **Outcome:** a trusted v5 report produces complete incremental evidence through native Git.
- **Path:** authority pages -> `admitReviewScopeWithGitHost` -> existing collector -> native Git -> validated admission output.
- **Risk:** timeout, cancellation, malformed output, or a missing checkpoint can yield incomplete evidence.
- **Evidence:** real temporary repositories prove baseline, incremental, same-head, and exact-checkpoint behavior.
  Focused tests prove timeout, cancellation, output overflow, and typed rejection.
- **Excluded:** CPU and memory quotas, transfer metering, kernel network isolation, custom process supervisors, model dispatch, manifests, and publication.

Use the existing Node subprocess pattern. Keep Git policy and process execution
small and local to the private Action library. Do not create a generic framework.
No Python, cgroup delegation, privileged setup, or separate hosted gate is required.

1. Validate host options and requests through owning Zod schemas.
2. Run Git with argv arrays, raw bytes, a remaining timeout, and an abort signal.
3. Preserve literal paths, replacement-object protection, and disabled executable helpers.
   Disable prompts, inherited credentials, and implicit lazy fetch during local collection.
4. Count stdout and stderr together before retaining output. Overflow fails without truncated evidence.
5. Return complete output and measured wall time. Remove CPU, memory, and transfer fields from the private port.
6. Use native Git to fetch a full checkpoint ID once from a trusted remote.
   Isolate fetch configuration from the target repository. Preserve HEAD, index, and worktree.
7. Stop Git and its ordinary process group on timeout, cancellation, or output overflow.
   Release owned timers, listeners, and temporary files on all exits.
8. Preserve the single 120-second admission deadline across setup, authority reads, and Git collection.
   Reuse cumulative wall and output budgets. Keep unavailable checkpoints as errors without baseline fallback.

```ts
// Before: kernel delegation and a custom supervisor.
const host = await createReviewGitHost({ reviewTarget, cgroupRoot, trustedRemote });

// After: native Git, with trusted fetch configuration only when needed.
const host = await createReviewGitHost({ reviewTarget, trustedRemote });
```

#### Test gates and next boundary

Run the production host in the existing real-Git fixtures for both object formats.
Prove complete baseline and incremental patches, same-head empty scope, literal
hostile paths, a missing checkpoint, and unchanged checkout state after fetch.
Cover timeout, cancellation, output boundaries, invalid requests, and expired admission.
Run test mapping before tests, then source typecheck, scoped lint, formatting,
Action bundle loading, and the existing CI checks. No privileged fixture remains.

This slice proves private admission with real Git. The production v4 review
caller remains unchanged. The next slice connects admitted discovery evidence
to model lanes and local finding admission; manifests and publication follow.


## Affected areas

- `libs/action-code-review/src/contracts.ts`
- `libs/action-code-review/src/review-history.ts`
- `libs/action-code-review/src/workflows/publication-workflow.ts`
- `workflows/code-review/contracts.ts`
- `workflows/code-review/workflow.ts`
- `workflows/code-review/tasks/review-history.ts`
- `workflows/code-review/tasks/review-git-evidence.ts`
- `workflows/code-review/tasks/review-lanes.ts`
- `workflows/code-review/tasks/review-synthesis.ts`
- `workflows/code-review/tasks/review-finalization.ts`
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
  and still in the PR diff can receive one. Cover imported target changes,
  added, removed, zero-hunk tree-entry, and no-change evidence; validate
  the cause locally before ID allocation.
- Test two baseline publishers and concurrent report updates in the same
  shared queue. Test stale guards, queue overflow, safe replay, duplicate dispatch,
  and cancellation during a write. Prove that one authoritative comment remains.
- Test explicit job permissions and the model worker's environment and storage
  boundary. Prove only the trusted publisher can write the bot comment.
- Test byte-stable manifests, pre-upload size failure, one verified artifact,
  explicit 90-day retention, policy rejection, artifact expiry, and
  missing-reference refusal without a baseline reset.
- Test canonical aggregate storage admission at both caps and one byte over.
  Include retained published artifacts, outstanding candidates, controls,
  reservations, concurrent admissions, incomplete inventory, uncertain upload,
  publication without released bytes, safe cleanup, and confirmed expiry.
- Test canonical model reuse, strict references, owner-link consistency, and
  early cancellation without a promised manifest. Test representative redaction
  fixtures in both sinks and hash-and-location-only evidence for unsafe excerpts.
- Test verification against sealed current-head sources. Reject another
  finding's evidence, stale revisions, unsealed paths, false digests or lines,
  and unsupported absence. Cover deletion, rename mapping, tree entries,
  redacted excerpts, uncertainty, and verification with no discovery scope.
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

The first private scope collector slice is proposed in
[PR #176](https://github.com/marcolink/seqlane/pull/176), based on PR #112 at `6688815`.
It has no production caller. Focused real-Git and port tests provide local evidence.
The production host was added in the follow-up slice described below. Other v5 delivery work remains pending.

Incremental review input is the checkpoint-to-head diff. Current-PR validation
is separate. A real-Git test covers 200 incremental paths with two patch
commands, complete discovery and validation inventories, and no earlier PR
patch in discovery input. File-type transitions retain both patch blocks.

A follow-up regression proves that older reviewed hunks in an edited file and
previously reviewed unchanged files stay out of incremental discovery input.
The focused collector suite passes 25 tests. The v5 contract carries untouched
findings as `not_reviewed`, schedules verification only for locally established
cause overlap, and skips all models for empty scope. Cause selection and
orchestration enforcement remain pending v5 delivery work.

Follow-up fixes validate the repository's storage hash format and require each
base, head, and checkpoint to resolve to its admitted full commit ID.
Real-Git regressions reject 40-character SHA-256 prefixes and accept full
SHA-1 and SHA-256 IDs. Command and checkpoint-fetch methods are explicit and
share one execution budget; 13 budget tests cover their routing and accounting.

Local verification passes the full Action library suite: 15 files and 150 tests.
Source typecheck, test mapping, formatting, and SDLC validation pass.
The test typecheck retains three errors in the untouched
`pr-code-review-example.spec.ts` at lines 1467 and 1532.
The current v4 workflow has no collector call and keeps its existing contracts.
Ripwire flags two short command-status helpers shared across Action packages.
The packages keep separate helpers because their ports and domain errors differ.

The follow-up private admission slice now validates shared v5 schemas and
bounded hidden transport before collecting Git evidence. Complete authority
lookup rejects duplicate reports, malformed records, and incomplete pagination.
All v1–v4 payloads are ignored and select the full current PR diff. Valid v5
uses its published `reviewedRevision` and preserves retained findings as reference
context. Malformed or future state blocks before collection.
The production v4 caller, model admission, and publication remain unchanged. The following slice supplies the private bounded host.

On 2026-10-07, the host requirements were revised before implementation changes.
PR #179 now uses native Git, timeout, cancellation, bounded output, and measured
wall time. The custom supervisor, transport, and privileged CI fixture are removed.
The earlier hosted verification proves the retired approach only.

Local verification passes: 28 library test files and 314 tests, four Action tests,
Action bundle loading, source typecheck, scoped lint, formatting, test mapping,
and SDLC validation. The real-Git tests now use the production host.
HTTPS integration proves exact non-ancestor checkpoint fetch for SHA-1 and SHA-256,
ignored target URL rewrites, and unchanged HEAD, index, and worktree.
Process tests prove timeout, cancellation, and combined-output boundaries.
The test typecheck retains the same three errors in the untouched
`pr-code-review-example.spec.ts` at lines 1467 and 1532.

Ripwire reports expected contract churn and a longer fetch function.
The longer function replaces the separate custom transport and protocol modules;
no suppression is recorded. Hosted CI for the revised code remains pending.

The scope selector, checkpoint validation, complete-evidence rules, model limits,
and publication guards remain unchanged. Full v5 production wiring is pending.

## Delivery state

Partial local implementation. No target-branch delivery claim is made here.

## Traceability

- Contract: [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md)
- Host limits: [requirement-complete-evidence](../specs/2026-09-13-incremental-pull-request-review-scope.md#requirement-complete-evidence)
- State and lifecycle: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Execution evidence: [spec.review-run-manifest-and-provenance](../specs/2026-09-14-review-run-manifest-and-provenance.md)
- Publication permissions and recovery: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md#requirement-publication-permissions)
- Host slice dependency: [trusted v5 admission task](./2026-09-14-unify-code-review-comment-state.md#next-pr-trusted-v5-report-admission)
- Host slice stack base: [PR #178](https://github.com/marcolink/seqlane/pull/178)
- Host implementation: [PR #179](https://github.com/marcolink/seqlane/pull/179)
