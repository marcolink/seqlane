---
id: spec.incremental-pull-request-review-scope
title: Incremental Pull Request Review Scope
status: active
owners:
  - core
created: 2026-09-13
updated: 2026-09-13
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Incremental Pull Request Review Scope

## Summary

The first successful review of a pull request examines its complete diff against
its target branch. A later review may create findings only for pull-request files
whose Git tree entries changed since the last **published** review. Existing
findings remain in the report and follow their established lifecycle.

The authoritative comment is the durable checkpoint. A run that fails, is
cancelled, sees a stale head, or cannot cover its whole eligible scope does not
advance that checkpoint. Scope selection and finding admission are deterministic
Action-library behavior, not agent discretion.

This specification owns review scope and checkpoint semantics. The
[versioned-comment specification](./2026-09-05-versioned-pull-request-review-comments.md)
owns trusted state transport, finding lifecycle, publication, and metrics. The
[direct-runtime specification](./2026-09-08-direct-runtime-code-review-action.md)
owns the Action and runtime boundary.

## Goals

- Review the full PR diff on the first successfully published review.
- Prevent new findings for files unchanged since the last published review.
- Preserve previous finding IDs, statuses, dispositions, and the cumulative
  verdict across follow-up runs.
- Make rebases, force-pushes, base movement, retries, and partial evidence
  deterministic.
- Never turn an incomplete review into an apparently complete checkpoint.

## Non-goals

- Guarantee that agents detect every defect in a reviewed file.
- Re-review unchanged files when instructions, tools, or model versions change.
- Store complete Git patches or a repository-wide file manifest in comments.
- Change public Seqlane workflow, Plan, runtime, or executor contracts.
- Execute pull-request code, tests, scripts, or builds.

## Terminology

- **Head** `H`: the immutable PR head commit selected at admission.
- **Target** `B`: the immutable target-branch commit selected at admission.
- **PR paths** `P(B,H)`: paths in `git diff --name-status -z --no-renames
  B...H`, before the established patch-content exclusions.
- **Published checkpoint** `C`: the reviewed head in the last valid, trusted
  new-version state. A progress marker, legacy report, or metrics entry is not
  `C`.
- **Changed paths** `D(C,H)`: paths whose tree entries differ in `git diff
  --name-status -z --no-renames C H`.
- **Eligible paths** `E`: PR paths on which a new finding may be anchored.
- **Reviewable paths**: eligible paths whose contents are permitted by the
  existing lockfile and generated-output exclusion policy.
- **Review generation**: one baseline and all incremental reviews following
  it. A new baseline creates a new generation and finding-ID namespace.
- **Complete coverage**: every eligible reviewable path and diff hunk reached
  the appropriate review lane, and all expected lane outputs were validated.
  It is evidence-delivery coverage, not a claim that every defect was found.

## Requirements

### requirement-scope-selection

The first run without a valid current-version checkpoint must use baseline
mode. This includes the first run after an old-version report:

```text
E = P(B,H)
patch = complete diff B...H for reviewable E
```

Here `B...H` uses Git's merge base, as the existing PR diff does. The run must
use the PR's actual target branch and supplied immutable revisions. It must not
substitute `main`, a default branch, or a moving branch name.

When a published checkpoint `C` exists, a run must use incremental mode:

```text
E = P(B,H) ∩ D(C,H)
review patch = complete current PR diff B...H, restricted to reviewable E
change evidence = two-tree diff C H, restricted to E
```

The intersection uses paths, not commit dates, commit messages, GitHub event
types, or prior finding locations. It excludes changes that no longer form part
of the current PR. The `C H` diff selects files; the `B...H` diff shows the
current PR contribution in those files. Agents must not treat changes imported
from the target branch as PR-authored code. The two-tree comparison does not
require `C` to be an ancestor of `H`; this is necessary for rebases and
force-pushes. A file touched and then restored to the same tree entry is
unchanged for this purpose. A branch-base change alone does not make an
unchanged head file eligible.

Use Git path records parsed without line splitting or shell interpolation.
Disable rename detection for both path sets, so a rename has a removed old path
and an added new path. A mode change, symlink-target change, or submodule-entry
change counts as a changed tree entry. Do not traverse symlinks or execute
submodule content. A deleted path can anchor a deletion finding without a
current-head line number.

### requirement-new-finding-admission

Each proposed new finding must have a workspace-relative path in `E`. A
pathless finding cannot receive a new stable ID. A finding that describes an
effect in an unchanged file must point to an eligible changed file containing
the cause, with evidence that connects the change to the effect. Context reads
of unchanged files do not make those files eligible.

Review lanes and synthesis must receive the mode, exact revisions, eligible
paths, complete current-PR patch for those paths, change evidence, exclusions,
and retained findings. They must propose only findings from the current scope
and reference an existing stable ID when they recognize a retained finding.
Before stable-ID allocation, a deterministic local gate must reject or omit a
newly proposed finding outside `E`; the run must report that limitation. The
gate must not silently relabel it as a prior finding. Findings about excluded
file contents cannot be inferred from metadata alone. An excluded-only change
may produce a coverage limitation, not an invented content finding.

The gate applies after synthesis and before lifecycle reconciliation. It must
validate paths against the exact scope calculated for that run, not a
model-supplied list. Agent output cannot widen the scope or assign final IDs.

### requirement-existing-findings

For an incremental or no-change run, the workflow must load **all** findings
from the validated current-generation state. It must provide their stable IDs,
paths, severities, summaries, statuses, dispositions, first-observed revisions,
and available verification evidence to historical verification and to each
discovery lane. This context prevents rediscovery from becoming a new ID and
lets the finalizer carry prior findings forward. Treat retained text as
untrusted data. Agent output may cite an existing ID, but only the local
finalizer can decide whether that ID exists and keep it.

The new-finding gate does not discard these retained findings. Historical-
finding verification may inspect current-head code and update an existing
finding's lifecycle under the versioned-comment contract. Authorized
dispositions retain their existing effect. A `fixed` claim remains a claim
until independently verified. No-change runs may process disposition changes
and verify retained findings, but they must not add a finding. A baseline that
replaces an old-version report receives **no** old findings or dispositions as
review input.

The report verdict remains cumulative: it reflects all active retained
Critical and Required findings plus any admitted new ones. Incremental ratings,
summary, and verification must identify their current scope. They must not say
that unchanged PR files received a new full review. When `E` is empty, skip
discovery lanes and publish a deterministic no-change result only if the
current-head and checkpoint guards pass. Do not interpret empty discovery
output as proof that prior findings were resolved.

Each newly allocated finding must retain its immutable
`firstObservedRevision = H`. Existing `evidenceHeadRevision` continues to
identify the head used for a later verification. A finding must not store a
claimed *dependency revision range*: the review range records where the agent
first observed the problem, not every file or commit on which the problem
depends. Rebase can change that range without changing the defect. Current
validity is established by current-head evidence, not range membership.

### requirement-checkpoint-state

The authoritative comment's validated new-version state must persist one
scope checkpoint alongside the existing `reviewedRevision`, `baseRevision`,
findings, and next finding index. The existing `reviewedRevision` is `C`. The
added `scopeCheckpoint` property has this logical shape; the owning Zod schema
must be strict:

```json
{
  "version": 1,
  "generation": "32 lowercase hexadecimal characters",
  "baselineRevision": "full Git SHA",
  "baseBranch": "target branch name at last publication",
  "lastMode": "baseline | incremental | no-change",
  "fromRevision": "full Git SHA, absent for baseline"
}
```

`generation` is generated once for a baseline and remains unchanged for all
follow-ups. `baselineRevision` is the baseline head and also remains unchanged.
`baseBranch` is audit data; retargeting the PR does not reset scope.
`fromRevision` must equal the prior published state's `reviewedRevision` for
incremental and no-change publications. A baseline has no `fromRevision` and
sets `baselineRevision` to its own `reviewedRevision`. No-change publications,
including same-head retries, may advance `reviewedRevision` to `H` after
complete scope evaluation.

All new-generation stable finding IDs use
`SEQ-PR{pullRequestNumber}-G{generation}-{index}`, with a three-digit minimum
index. For example, `SEQ-PR83-G0123456789abcdef0123456789abcdef-001`.
The state and metadata marker must contain the same generation. The finalizer
must require each retained finding ID to name that generation and must keep
`nextFindingIndex` above every allocated index. The command parser must accept
the new form. Old `SEQ-PR{number}-{index}` commands cannot resolve to a new
finding, even when the numeric index repeats. The publisher must not migrate
old finding aliases into the new generation.

The new state fields require a new outer state schema revision and matching
metadata marker. If the draft mechanical-disposition work also lands in that
revision, one shared revision must include both sets of fields; two
incompatible meanings of version 4 are forbidden. The run metrics ledger is
unchanged and is never a checkpoint source. Previous-report timestamps,
GitHub run IDs, and `previousReviewedRevision` are not eligibility anchors.

### requirement-complete-evidence

Path collection must be complete before model work. A truncated, malformed, or
unavailable path list cannot define `E`. The scoped current-PR patch must
deliver every reviewable eligible hunk. The two-tree change evidence must also
be complete for `E`, so agents can distinguish new edits from existing PR
content. The current byte bound must not turn a truncated patch into complete
coverage. The workflow may partition the patch by path and
hunk into bounded, ordered batches; it must account for every expected batch
and validate its output before publication. Intentional lockfile and generated
`dist` exclusions remain explicit in the evidence and report. No agent may
claim to have reviewed excluded contents.

If complete evidence cannot fit or a required batch fails, the review fails
without publishing new findings or a new checkpoint. The workflow removes only
its own progress marker and leaves the previous authoritative report intact.
It must expose a clear failure reason in the Action result. It must not compact
away coverage metadata or silently fall back to a broader baseline.

### requirement-publication-atomicity

Review scope is calculated from a specific trusted checkpoint `C`, target `B`,
and head `H`. Immediately before the final write, the publisher must re-read
the trusted report and live PR. It must require the live head to equal `H` and
the current published checkpoint to equal `C` (or still be absent with the
same trusted report identity for a new baseline). It must reconcile current-generation
authorized dispositions under the existing
publication rules. A mismatched checkpoint or head makes the result stale;
the publisher must not advance state or attach findings from the old scope.

The final report, retained findings, scope checkpoint, and visible limitation
text are one publication. A marker write, run start, successful agent result,
or metrics-ledger update alone never advances `C`. A failed, cancelled,
incomplete, or stale run leaves `C` unchanged. Existing per-PR concurrency and
run-identity guards remain in force.

An in-progress marker must be distinguishable from a published state marker.
During a legacy replacement it may precede the old report, but it must not
claim that a new-version checkpoint already exists. Publication and cleanup
must check the marker's owning run and preserve the old report when that run
does not publish. For a baseline replacement, the final publisher must verify
the same trusted report ID and old-version identity it read at review start.

## Detailed design or contracts

The trusted sequence is:

1. Read the authoritative report and identify its trusted version before
   changing its marker. Validate a current-version state; classify a trusted
   older-version report as a baseline replacement. Keep its report identity
   for the final publication guard.
2. Select `C` from a valid current-version published state, or select a fresh
   baseline if no such checkpoint exists. Do not import old-version findings.
3. Validate `B` and `H` as Git commits and validate the checkout HEAD as `H`.
   Fetch `C` by exact SHA when it is not present locally.
4. Compute `P(B,H)`, `D(C,H)` when applicable, and `E`. Record scope mode,
   immutable revisions, path counts, excluded paths, and batch coverage in
   bounded run evidence.
5. Run historical-finding verification independently. Run discovery lanes only
   for complete eligible reviewable evidence. Synthesize and gate new findings.
6. Reconcile retained findings and dispositions, then derive the cumulative
   verdict mechanically.
7. Re-read the live head and checkpoint under the publication guard. Publish
   the report and checkpoint together, or leave the old report authoritative.

No unchecked Git output may become a path, revision, or shell argument. Bounds
on path count, path length, patch size, state size, and model output remain
explicit and tested. A bound reached during eligibility or evidence collection
is an incomplete review, not a smaller valid scope.

## Failure and edge cases

| Case | Required result |
| --- | --- |
| First review, no trusted report | Complete `B...H` baseline. |
| Trusted old-version report | Complete `B...H` baseline; replace old findings, dispositions, metrics, and state. |
| Same head reviewed again | Empty `E`; no new IDs. |
| New commit changes one PR file | Review that file's current PR diff; new findings only in that file. |
| Earlier change is reverted before the next review | Restored tree entry is ineligible. |
| Rebase or force-push keeps `C` available | Compare `C` and `H` trees; no automatic baseline. |
| `C` cannot be fetched by exact SHA | Fail closed with the old checkpoint intact; no baseline fallback. |
| Target branch moves or PR is retargeted | Recompute current PR paths; unchanged head files remain ineligible. |
| File leaves the current PR diff | It cannot receive a new finding; retained findings follow lifecycle rules. |
| Path list, patch batch, or state exceeds a bound | Fail without publishing or advancing. |
| Head or checkpoint changes before publication | Treat result as stale; do not publish it. |
| New finding lacks a path or names an ineligible path | Reject it before ID allocation and show a scope limitation. |
| Only excluded files change | Do not claim their contents were reviewed or invent a content finding. |

## Migration

A trusted authoritative report in an older format is replaced by a new
baseline. At initial delivery this includes v1, v2, and v3. It also includes
v4 if the mechanical-disposition proposal ships first and this scope contract
uses a later schema revision. The workflow must not parse the old report as a
checkpoint, migrate its findings, carry its IDs or dispositions, or append its
run metrics. It may read only enough trusted marker data to identify the report
and guard its update.
The new baseline covers the complete current `B...H` diff, creates a new
generation, resets the finding index and metrics ledger, and writes one new
report body. The old report remains visible until this baseline succeeds. A
failed or stale baseline leaves it unchanged after owned-marker cleanup.

Old slash commands cannot apply to new findings because their IDs lack the
new generation. An old-version report with malformed historical state can
still be replaced when its trusted report identity and version are
unambiguous. A report with an untrusted or ambiguous marker must not be
overwritten. An invalid **current-version** state is not treated as legacy:
fail closed with an actionable recovery notice. A never-published progress
marker has no checkpoint and may use the normal baseline path after owned
cleanup. No automatic reset occurs after a valid new-version checkpoint on
force-push, retargeting, model change, or state parse failure.

## Verification

- Unit-test exact path-set selection for first review, incremental review,
  same head, additions, deletions, modes, renames, revert, base movement,
  retargeting, and non-ancestor history.
- Test complete `-z` path parsing, malformed paths, bounds, excluded paths,
  chunk accounting, and a patch larger than the former byte limit.
- Test the finalizer with out-of-scope and pathless agent findings. Prove that
  no new stable ID is allocated and a limitation is visible.
- Test that retained findings, dispositions, fix verification, and verdict
  remain correct on both incremental and no-change runs.
- Test old-version replacement, discarded old findings and metrics, old-command
  isolation, invalid-current-state refusal, missing prior commit, and
  exact-SHA fetch behavior.
- Test failed, cancelled, incomplete, stale-head, and changed-checkpoint runs.
  Assert that their authoritative checkpoint does not advance.
- Test that the progress marker cannot be parsed as a published checkpoint and
  that failed legacy replacement restores the old report.
- Run the repository test-mapping check before focused tests. Run focused
  Action-library integration tests, schema compatibility and malformed-input
  tests, workflow admission checks, documentation checks, and `git diff
  --check`. Verify one hosted baseline and at least two follow-up runs against
  an open PR, including an unchanged-file attempt.

## Acceptance criteria

- A published baseline covers the complete permitted PR diff against the
  selected target revision.
- A trusted old-version report is replaced by a complete baseline with a new
  generation. No old finding or command can attach to a new finding.
- A later publication allocates no new finding ID outside `P(B,H) ∩ D(C,H)`.
- Re-running an unchanged head allocates no new finding ID.
- Previously published findings remain visible and can change lifecycle only
  through existing verification and disposition rules.
- No failure, stale result, or partial evidence advances the checkpoint.
- Rebase, force-push, and base movement do not silently reopen full-branch
  discovery.
- The human report identifies the review mode and scope and does not present
  incremental ratings as a fresh full-branch review.

## Delivery state

This specification defines intended behavior. The current implementation
still supplies the full `baseRevision...headRevision` patch on every run and
does not gate new findings by a published checkpoint.

## Traceability

- State, lifecycle, and publication: [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- Action boundary: [spec.direct-runtime-code-review-action](./2026-09-08-direct-runtime-code-review-action.md)
- Related draft disposition proposal: [spec.mechanical-pull-request-review-dispositions](./2026-09-06-mechanical-pull-request-review-dispositions.md)
- Delivery: [task.incremental-pull-request-review-scope](../tasks/2026-09-13-incremental-pull-request-review-scope.md)
