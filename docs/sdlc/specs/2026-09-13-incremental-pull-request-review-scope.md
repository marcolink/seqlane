---
id: spec.incremental-pull-request-review-scope
title: Incremental Pull Request Review Scope
status: active
owners:
  - core
created: 2026-09-13
updated: 2026-09-14
upstream:
  - spec.versioned-pull-request-review-comments
  - spec.review-run-manifest-and-provenance
supersedes: []
---

# Incremental Pull Request Review Scope

## Summary

The first successful review of a pull request examines its complete diff against
its target branch. Later reviews select only pull-request files changed since
the last **published** review. A new finding must also have a verified cause
anchor in that new change, not merely in an older hunk of a selected file.
Existing findings remain in the report and follow their established lifecycle.

The authoritative comment is the durable checkpoint. A run that fails, is
cancelled, sees a stale head, or cannot cover its whole eligible scope does not
advance that checkpoint. Scope selection and finding admission are deterministic
Action-library behavior, not agent discretion.

Each admitted run also produces one versioned, machine-readable manifest. The
manifest records frozen input, provenance, coverage outcomes, limitations, and
terminal status. The authoritative comment remains the trusted cross-run
checkpoint; it is not the complete execution trace.

This specification owns review scope and checkpoint semantics. The
[versioned-comment specification](./2026-09-05-versioned-pull-request-review-comments.md)
owns trusted state transport, finding lifecycle, publication, and metrics. The
[direct-runtime specification](./2026-09-08-direct-runtime-code-review-action.md)
owns the Action and runtime boundary.

## Goals

- Review the full PR diff on the first successfully published review.
- Prevent new findings whose cause is outside the change since the last
  published review, including older hunks in a newly edited file.
- Preserve previous finding IDs, statuses, dispositions, and the cumulative
  verdict across follow-up runs.
- Make rebases, force-pushes, base movement, retries, and partial evidence
  deterministic.
- Never turn an incomplete review into an apparently complete checkpoint.
- Make coverage, finding validity, publication, and automation admission
  independently visible.
- Preserve enough bounded evidence to explain location, comparison, retry, and
  failure decisions without trusting model assertions.

## Non-goals

- Guarantee that agents detect every defect in a reviewed file.
- Re-review unchanged files when instructions, tools, or model versions change.
- Store complete Git patches or a repository-wide file manifest in comments.
- Change public Seqlane workflow, Plan, runtime, or executor contracts.
- Execute pull-request code, tests, scripts, or builds.

## Terminology

- **Head** `H`: the immutable PR head commit selected at admission.
- **Target** `B`: the immutable target-branch commit selected at admission.
- **Report classification**: exactly one of `absent`, `legacy`, `current`, or
  `invalid-current`; it is selected before scope calculation and reused by
  migration and publication.
- **PR paths** `P(B,H)`: paths in `git diff --name-status -z --no-renames
  B...H`, before the established patch-content exclusions.
- **Published checkpoint** `C`: the reviewed head in the last valid, trusted
  new-version state. A progress marker, legacy report, or metrics entry is not
  `C`.
- **Changed paths** `D(C,H)`: paths whose tree entries differ in `git diff
  --name-status -z --no-renames C H`.
- **Eligible paths** `E`: PR paths selected by the baseline or incremental
  comparison, before content exclusions.
- **Excluded paths** `X`: paths in `E` covered by the established lockfile or
  generated-output content exclusions.
- **Reviewable eligible paths** `R = E - X`: paths whose content may be sent to
  review lanes and on which new findings may be anchored.
- **Review generation**: one baseline and all incremental reviews following
  it. A new baseline creates a new generation and finding-ID namespace.
- **Complete coverage**: every path in `R` and its diff hunks reached
  the appropriate review lane, and all expected lane outputs were validated.
  It is evidence-delivery coverage, not a claim that every defect was found.
- **Scope identity**: the immutable, discriminated admission value carrying the
  pull-request number, target branch, base revision, head revision, checkpoint
  revision, and trusted report identity required by its mode. A new baseline
  has no prior report identity; a legacy replacement has the prior trusted
  report ID and legacy marker identity; an incremental or no-change run has
  the current trusted report ID and checkpoint revision.
- **Evidence batch**: one bounded, typed unit of scoped Git evidence. A batch
  has an ordinal, path list, patch bytes, change-evidence bytes, and coverage
  counts. A batch result records completion, parsed paths, hunks, byte counts,
  and failure or limitation data.
- **Run manifest**: the versioned, immutable machine-readable record of one
  admitted review, including frozen input, provenance, coverage outcomes,
  limitations, and terminal status.
- **Finding evidence**: the bounded source excerpt and diff side used to support
  a finding and derive its current presentation location.
- **Not reviewed**: a comparison outcome for a prior finding whose path was not
  in the later run's reviewable scope. It is never equivalent to resolved.

## Requirements

### requirement-scope-selection

Classify the trusted report before selecting scope. The classifications are
mutually exclusive:

| Classification | Condition | Scope action |
| --- | --- | --- |
| `absent` | No authoritative report exists. | Start a baseline. |
| `legacy` | The trusted marker is a recognized older schema and the report ID plus exact marker identity are unambiguous. | Start a baseline replacement; import no old state. |
| `current` | The trusted marker is the supported current schema and its decoded state passes strict validation, including identity and checkpoint validation. | Start an incremental or no-change review from the persisted checkpoint. |
| `invalid-current` | A current-version marker has malformed, oversized, unsupported, mismatched, or undecodable state; the marker names a future version; or report identity is ambiguous. | Fail closed. Preserve the report and checkpoint. |

Only `absent` and `legacy` select baseline mode. `invalid-current` must never
be relabeled as `absent` or `legacy`. Reuse this classifier without variation
in scope selection, migration, and publication.

A legacy v3 publication progress marker is not a v5 checkpoint. Scope
selection ignores that notice and uses the last completed trusted state.
The v5 path writes no progress marker or pending report.

Baseline mode uses the complete current PR diff:

```text
E = P(B,H)
R = E - X
patch = complete diff B...H for R
```

Here `B...H` uses Git's merge base, as the existing PR diff does. The run must
use the PR's actual target branch and supplied immutable revisions. It must not
substitute `main`, a default branch, or a moving branch name.

When a published checkpoint `C` exists, a run must use incremental mode:

```text
E = P(B,H) ∩ D(C,H)
R = E - X
review patch = complete current PR diff B...H, restricted to R
change evidence = two-tree diff C H, restricted to R
```

The intersection uses paths, not commit dates, commit messages, GitHub event
types, or prior finding locations. It excludes changes that no longer form part
of the current PR. The `C H` diff selects files and supplies the required
new-finding cause anchors; the `B...H` diff shows the complete current PR
contribution in those files as review context. A path being in `R` alone does
not authorize a new finding from an unchanged hunk of that file. Agents must
not treat changes imported from the target branch as PR-authored code. The
two-tree comparison does not require `C` to be an ancestor of `H`; this is
necessary for rebases and force-pushes. A file touched and then restored to
the same tree entry is
unchanged for this purpose. A branch-base change alone does not make an
unchanged head file eligible.

Before using `C`, validate the full SHA with an exact Git object query and
require `git cat-file -e "${C}^{commit}"` (or an equivalent typed object query)
to succeed. A tree, blob, tag, abbreviated SHA, missing object, or other object
type is invalid. If `C` is absent locally, fetch that exact SHA through the
trusted Git adapter, then repeat the commit-object validation. Do not compute
`D(C,H)` until this check succeeds. A failed fetch or validation fails closed
and leaves the previous report authoritative.

Use Git path records parsed without line splitting or shell interpolation.
Disable rename detection for both path sets, so a rename has a removed old path
and an added new path. A mode change, symlink-target change, or submodule-entry
change counts as a changed tree entry. Do not traverse symlinks or execute
submodule content. A deleted path can anchor a deletion finding without a
current-head line number.

Parse `-z` output as NUL-delimited byte records and decode paths without
replacement characters. Reject empty paths, invalid UTF-8, absolute paths,
and `.` or `..` path segments. Keep the same canonical relative path bytes for
scope membership and Git arguments. Construct scoped diffs with an argv-based
Git process, `git --literal-pathspecs diff ... -- <paths>`, using each validated
path as one literal argument. Do not interpolate paths into a shell command or
combine them with Git pathspec-magic exclusions. Filter excluded paths in the
trusted scope selector before constructing the argv. Parse the returned diff's
paths and fail if they differ from the requested reviewable path set. The
batch limits below also bound argv size. When `R` is empty, do not run a scoped
diff with an empty path list; it could otherwise select the full repository.

### requirement-new-finding-admission

Each proposed new finding must have a workspace-relative path in `R`. A
pathless finding cannot receive a new stable ID. Its primary cause anchor
must overlap a changed line or changed tree-entry record in the baseline
`B...H` evidence or, for incremental mode, in the two-tree `C H` evidence.
For a text hunk, an old-side removed line or new-side added line qualifies;
unchanged context lines alone do not. A finding that describes an effect in
an unchanged file must point to the eligible changed cause and use the
unchanged file only as supporting context. A no-change run admits no new
findings.

Review lanes and synthesis must receive the mode, exact revisions, `R`, the
complete current-PR patch for `R`, change evidence, exclusions, and retained
findings. They must propose only findings from the current scope
and reference an existing stable ID when they recognize a retained finding.
Before stable-ID allocation, a deterministic local gate must reject or omit a
newly proposed finding outside `R` or without a verified current-change cause
anchor; the run must report that limitation. The gate must not silently
relabel it as a prior finding. Findings about excluded file contents cannot be
inferred from metadata alone. An excluded-only change
may produce a coverage limitation, not an invented content finding.

The gate applies after synthesis and before lifecycle reconciliation. It must
validate paths against the exact `R` and cause anchors calculated for that
run, not a model-supplied list. Agent output cannot widen the scope or assign
final IDs.

Every proposed new finding must have bounded evidence from a sealed
ManifestItem. The trusted finalizer, not the agent, validates this strict model
and persists it in both the sealed manifest and bounded trusted report state:

```text
FindingEvidence = {
  itemId: sealed ManifestItem ID
  evidenceForm: "pr-patch" | "change-evidence"
  itemEvidenceDigest: lowercase SHA-256 matching that item
  path: validated relative path matching that item
  supportingEvidence: array of at most 4 {
    role: "cause" | "source" | "sink" | "guard"
    path: validated relative path
    sourceRevision: full Git commit SHA
    sourceDigest: lowercase SHA-256
    excerpt: nonempty UTF-8 string, at most 500 bytes
    excerptDigest: lowercase SHA-256
  }
} & (
  | { anchorKind: "changed-text"
      side: "old" | "new"
      sourceRevision: full Git commit SHA
      sourceDigest: lowercase SHA-256 of frozen source bytes
      excerpt: nonempty UTF-8 string, at most 500 bytes
      excerptDigest: lowercase SHA-256 of exact excerpt bytes
      changedStartLine: positive integer
      changedEndLine: integer >= changedStartLine }
  | { anchorKind: "changed-tree-entry"
      beforeEntryDigest: lowercase SHA-256 or absent
      afterEntryDigest: lowercase SHA-256 or absent }
)

LocationStatus =
  | { kind: "located"; side: "old" | "new";
      startLine: positive integer; endLine: integer >= startLine }
  | { kind: "unlocated"; reason: bounded nonempty string }
  | { kind: "ambiguous"; reason: bounded nonempty string;
      candidateCount: positive integer }
```

New-baseline and legacy-replacement findings reference a pr-patch item;
incremental findings reference a change-evidence item. A no-change run cannot
create one. The trusted
finalizer proves that changedStartLine through changedEndLine overlaps added
or removed lines in that exact frozen hunk and that the primary excerpt
includes at least one of those lines. It derives these lines locally;
model-supplied positions are untrusted. For a zero-hunk binary, mode, or
tree-entry change, changed-tree-entry must reference the matching changed
entry record and has no invented text line. The baseline old side is the
merge-base tree; the incremental old side is C. The new side is H.

The finalizer verifies the item, path, form, revisions, source bytes, excerpts,
and digests against the frozen evidence and records each referenced source
digest in the manifest. Supporting context may come from other readable files
but cannot widen R or replace the primary changed anchor. A located range
must be on the named changed side and revision; a tree-entry anchor is
unlocated. If no unique safe range exists, the finding remains visible as
unlocated or ambiguous with a limitation. Invalid or missing cause evidence
makes finding validation fail.

Finding identity is a matching aid, separate from presentation location and
the publisher-assigned public ID. The finalizer computes a versioned
identityKey from the trusted defect kind and a whitespace-normalized,
evidence-verified text cause or changed tree-entry digests. It computes
occurrenceKey from identityKey, the verified path, and ordered digests of
validated supporting evidence.
Line numbers, severity, summary, and recommendation are excluded. The trusted
finalizer validates every input to these hashes. No AST parser, language-specific
declaration resolver, or claimed data-flow proof is required in this
iteration. Identical prose alone never merges findings.

The identityKey is SHA-256 of canonical JSON containing schema
review.finding-identity/v1, the trusted defect kind, anchor kind, and cause
digest. For text, the cause digest hashes the excerpt after trimming and
collapsing ASCII whitespace runs to one space. For a tree-entry change, it
hashes the before and after entry digests, including an explicit absent side.
The occurrenceKey is SHA-256 of canonical JSON containing identityKey, the
validated primary path, and the ordered supporting-evidence roles, paths,
source digests, and excerpt digests. Canonical JSON sorts object keys and
preserves array order. The finalizer persists both keys and their typed
inputs so a later reader can validate the derivation.

Equal keys permit deduplication only when local evidence yields one
unambiguous occurrence. Different supporting contexts or paths remain
separate, including similar security defects. An agent may cite a retained
public ID, but the finalizer accepts continuity only after a one-to-one
evidence match against the retained finding. A verified one-to-one match may
preserve that ID across path or line movement, rewording, or changed
recommendations even when occurrenceKey changes. An ambiguous or unsupported
match cannot silently merge findings or claim resolution; it is visible as
a limitation and receives no new stable ID until evidence is sufficient.
Normalizer versions are pinned for one generation, and a version change
cannot silently rekey retained history.

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
that unchanged PR files received a new full review. When `R` is empty, skip
discovery lanes and publish a deterministic no-discovery result only if the
publication guards pass. Do not interpret empty discovery
output as proof that prior findings were resolved.

Each newly allocated finding must retain its immutable
`firstObservedRevision = H`. Existing `evidenceHeadRevision` continues to
identify the head used for a later verification. A finding must not store a
claimed *dependency revision range*: the review range records where the agent
first observed the problem, not every file or commit on which the problem
depends. Rebase can change that range without changing the defect. Current
validity is established by current-head evidence, not range membership.

Comparison must produce four disjoint outcomes: `new`, `persisting`, `resolved`,
and `not_reviewed`. `comparisonOutcome` is a separate typed field from lifecycle
status, severity, and disposition. A finding can be `resolved` only after the
later run reviewed the relevant path and current-head verification supports that
result. An incremental run that did not select a path must preserve the finding
as `not_reviewed` and carry its lifecycle forward.

The report state and machine-readable manifest must persist the outcome for each
retained finding. The human projection must render `not_reviewed` distinctly
from `resolved`, including the omitted scope. Verification and authorized
dispositions have precedence over comparison presentation: a disposition can
keep a finding addressed or dismissed, while `not_reviewed` cannot alter its
lifecycle. Only current-head verification can establish `resolved` or
`reopened`.

### requirement-run-manifest-and-lifecycle

Manifest schema, item identity, terminal outcomes, persistence, bounds,
integrity, and provenance are defined by the canonical
[spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md).
This scope contract requires the manifest to carry the same immutable
`ScopeIdentity`, selected paths, exclusions, and evidence-batch plan used here.

### requirement-provenance-and-explainability

Rule trust, precedence, configuration hashing, and bounded explanations are
defined by [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md).
Scope selection remains separate from rule resolution; this spec owns `E`, `X`,
and `R`, while the manifest spec records why each path was selected or excluded.

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

The run metrics ledger is unchanged and is never a checkpoint source. The
manifest is the source for coverage and lifecycle evidence; the ledger remains
the source for rendered run metrics.
Previous-report timestamps, GitHub run IDs, and `previousReviewedRevision` are
not eligibility anchors.

The schema-evolution matrix is canonical:

| State revision | Fields and marker | Readers | Migration and replacement |
| --- | --- | --- | --- |
| v3 | Existing lifecycle state, v3 metadata marker, numeric finding IDs. | Current v3 reader. | Accepted as legacy when the scope feature is enabled; replaced by a new baseline. |
| v4 | Transitional mechanical-disposition state: v3 fields plus monotonic state revision and writer identity; v4 marker. It has no scope checkpoint and is never an incremental checkpoint for this feature. | v4 disposition reader and the scope reader as legacy. | If published before v5, v3 migrates to v4 for disposition work. The first scope-capable publication replaces v4 with a fresh v5 baseline and discards v4 findings, dispositions, metrics, and checkpoint. |
| v5 | Unified current state: v4 disposition fields plus `scopeCheckpoint`, generation-qualified finding IDs, typed identities and comparisons, strict run status, required sealed manifest and final-operation references with digests, and the v5 marker. | v5 reader only for current operation; older readers reject it. | v3 or v4 is legacy and is replaced by a fresh v5 baseline. Invalid v5 state, including a missing manifest reference, is `invalid-current` and fails closed. |

The v5 schema is the only target for the incremental scope implementation.
If incremental scope lands before mechanical dispositions, it still writes v5
with the disposition fields present and empty where permitted. If mechanical
dispositions land first, they may write v4, but they must not claim v4 is the
current scope checkpoint. This table prevents one revision from having two
meanings. The outer state revision, metadata marker, and compressed envelope
must agree. A trusted old report is replaced; it is never partially migrated
into v5.

### requirement-complete-evidence

Path collection must be complete before model work. A truncated, malformed, or
unavailable path list cannot define `E`. The scoped current-PR patch must
deliver every hunk in `R`. The two-tree change evidence must also be complete
for `R`, so agents can distinguish new edits from existing PR content. The
current byte bound must not turn a truncated patch into complete coverage.
The workflow may partition the patch by path and hunk into bounded, ordered
batches; it must account for every expected batch and validate its output
before publication. Intentional lockfile and generated `dist` exclusions remain
explicit in the evidence and report. No agent may claim to have reviewed
excluded contents.

Pre-model Git work has its own budget beginning when admission accepts the
event. This is separate from the model-phase elapsed-time ceiling and does not
change the unapproved decision about when the overall review deadline starts:

These limits are required because the review consumes untrusted repository
content and can fan out work across batches, lanes, and retries. Without hard
ceilings, a large diff, pathological path names, repeated failures, or an
oversized model context could consume the Action's available CPU, memory,
output, or wall time and still leave an incomplete review looking successful.
The ceilings make completeness decidable: the workflow either accounts for the
whole permitted scope within the budget or fails closed without publishing.
They are normative defaults owned by the Action library. A model, review lane,
or repository input cannot raise them for one run.

| Resource | Maximum |
| --- | ---: |
| Admission-to-model-start wall time | 120 seconds |
| One Git subprocess wall time | 30 seconds |
| Cumulative Git subprocess wall time | 90 seconds |
| Cumulative Git subprocess CPU time | 60 seconds |
| Peak Git subprocess memory | 256 MiB |
| Git stdout plus stderr before parsing | 2,048,000 bytes |
| Exact-checkpoint fetch transfer | 16 MiB |
| Exact-checkpoint fetch wall time | 30 seconds |

The limits apply in layers:

1. Admission constructs one immutable budget object containing the limits and
   zeroed monotonic counters. The scope selector and evidence collector reserve
   path, hunk, batch, byte, and Git-operation capacity before work starts.
2. The bounded Git adapter wraps every subprocess and exact-SHA fetch. It
   streams NUL-delimited output, enforces wall, CPU, memory, transfer, and
   output caps, and kills the complete process group on a breach. It returns a
   typed limit failure; it does not retry outside the same budget.
3. Before model fan-out, the orchestrator preflights all planned batch,
   invocation, token, and elapsed-time capacity. Before each invocation it
   reserves the final input and one invocation unit, including retries and
   retained-finding verification. Dynamic overruns cancel the run and cannot
   be hidden by adding batches or changing lanes.
4. Every breach records the resource, observed value, limit, and operation in
   bounded run evidence. A pre-model breach makes zero model calls. Any later
   breach fails the run, leaves the previous report and checkpoint
   authoritative, and prevents publication. Boundary and one-over-limit cases
   are covered by the verification tests below.

Run Git through a bounded subprocess adapter that streams NUL-delimited path
records, caps output before buffering, and aborts the process group when any
limit is reached. The adapter must report which limit fired. It must never
retry an exact-SHA fetch outside the cumulative budget. A pre-model budget
failure makes zero model calls and preserves the previous checkpoint.

Path selection, evidence collection, and model orchestration are separate
owners. The pure scope selector owns `E`, `X`, `R`, and the immutable scope
identity. The Git-evidence collector owns typed batch construction and bounded
subprocesses. The workflow orchestrator owns lane fan-out, retries, aggregate
budgets, result aggregation, and publication admission. Review lanes never
select paths or enforce the global budget.

The batch contracts are:

```text
EvidenceBatchPlan {
  scopeIdentity: ScopeIdentity
  ordinal: positive integer
  paths: non-empty array of validated relative paths
  expectedHunks: non-negative integer
  expectedPatchBytes: bounded integer
  expectedChangeBytes: bounded integer
}

EvidenceBatchResult {
  scopeIdentity: ScopeIdentity
  ordinal: positive integer
  status: "complete" | "failed" | "cancelled"
  paths: array of validated relative paths
  patch: bounded text
  changeEvidence: bounded text
  hunkCount: non-negative integer
  patchBytes: non-negative integer
  changeBytes: non-negative integer
  limitations: bounded array of strings
}
```

The collector must emit exactly one result for every plan ordinal, in ordinal
order after aggregation. Each result must echo the scope identity and its
planned paths. Aggregation must reject duplicate or missing ordinals, identity
mismatches, returned paths outside the plan, returned paths omitted from the
plan, byte or hunk counts over the plan, and any failed or cancelled batch.
It must verify that the union of completed result paths equals `R` and that
the sum of hunk and byte counts matches the pre-model plan. It must preserve
limitations in deterministic ordinal order.

After batch aggregation, the orchestrator deduplicates findings by normalized
stable ID, then by the canonical `(identityKey, occurrenceKey)` pair with local
same-occurrence verification. It retains the highest severity and deterministic
first occurrence for exact duplicates;
distinct occurrence keys remain independent. Only the aggregated result enters
synthesis. A missing or ambiguous identity or occurrence key is a limitation and
cannot allocate a new stable ID; path and line may be shown only as evidence and
presentation metadata.

The invocation policy is fixed: run history verification once for the retained
current-generation findings, run each configured discovery lane once per
evidence batch, and run synthesis once over the deterministic aggregate. A
retry consumes another invocation budget unit and must reuse the same batch
ordinal and scope identity. Do not fan out discovery lanes when `R` is empty;
the finalizer may still process retained findings and dispositions.

The complete run plan has these hard ceilings:

| Resource | Maximum |
| --- | ---: |
| Eligible paths, including excluded paths | 200 |
| Emitted diff hunks across both evidence forms | 1,000 |
| Evidence batches | 8 |
| Bytes in one evidence batch | 512,000 |
| Bytes across all review patches and change evidence | 2,048,000 |
| Model invocations, including retries and history verification | 26 |
| Cumulative model-facing input tokens across invocations | 500,000 |
| Elapsed time from first model call through finalization | 20 minutes |

Before model fan-out, compute the complete path, hunk, byte, and batch counts.
Compute token counts for known model requests with the configured model's
tokenizer, including repeated history and instruction context. Reserve the
maximum schema-bounded result size for requests whose input depends on earlier
model output. If a tokenizer is unavailable or any planned ceiling is exceeded,
fail before model work. Before each later invocation, count its final input
against the remaining token budget. Count retries as new invocations. Cancel
the review when the elapsed-time ceiling is reached. A dynamically exceeded
ceiling also fails without publication or checkpoint advancement.

If complete evidence cannot fit or a required batch fails, the review fails
without publishing new findings or a new checkpoint. The workflow removes only
no v5 report and leaves the previous authoritative report intact.
It must expose a clear failure reason in the Action result. It must not compact
away coverage metadata or silently fall back to a broader baseline.

### requirement-scope-publication-guard

Review scope is calculated from a specific trusted checkpoint `C`, target
branch name, target commit `B`, and head `H`. Capture all four at admission.
Represent that admission as one strict discriminated `ScopeIdentity` value. The
variant is selected by the trusted report classifier and cannot be changed by
agent output:

```text
CommonScopeIdentity {
  pullRequestNumber: positive integer
  targetBranch: non-empty branch name
  baseRevision: full Git commit SHA
  headRevision: full Git commit SHA
}

ScopeIdentity =
  CommonScopeIdentity & {
    mode: "new-baseline"
    checkpointRevision: absent
    reportId: absent
  }
  | CommonScopeIdentity & {
    mode: "legacy-replacement"
    checkpointRevision: absent
    reportId: trusted comment ID
    legacyMarker: {
      schemaVersion: positive integer
      markerDigest: lowercase hexadecimal SHA-256 digest of exact marker bytes
    }
  }
  | CommonScopeIdentity & {
    mode: "incremental" | "no-change"
    checkpointRevision: full Git commit SHA
    reportId: trusted current-version comment ID
  }
```

The scope selector, every `EvidenceBatchPlan` and `EvidenceBatchResult`, the
review input, finalization snapshot, and publication request must carry this
same value. The workflow must reject a missing field, revision mismatch,
variant mismatch, report-ID mismatch, legacy-marker mismatch, or a value that
was reconstructed from model output. A legacy replacement must carry the exact
trusted old-version marker identity read at admission; a new baseline must
carry no prior report identity.
The publisher revalidates this immutable scope identity before publication.
The live head, target branch and commit, checkpoint when present, and
variant-specific trusted report identity must still match. A new baseline
requires an absent authoritative report; a legacy replacement requires the
captured old report ID and marker. A mismatch is stale and requires a new scope
calculation. Only a successful final authoritative report can establish the
next checkpoint `C`. The
[publisher-owned final write and shared queue](./2026-09-05-versioned-pull-request-review-comments.md#requirement-publication-state-machine)
define write ordering, stale guards, uncertain-result readback, and the
one authoritative checkpoint update.

## Detailed design or contracts

The trusted sequence is:

1. Read the authoritative report and identify its trusted version before
   changing its marker. Validate a current-version state; classify a trusted
   older-version report as a legacy replacement. Capture the exact trusted
   report ID and old-version marker identity for the legacy `ScopeIdentity`
   publication guard. An absent report selects the new-baseline variant.
2. Select `C` from a valid current-version published state, or select a fresh
   baseline if no such checkpoint exists. Do not import old-version findings.
3. Validate `B` and `H` as Git commits and validate the checkout HEAD as `H`.
   Fetch `C` by exact SHA when it is not present locally, then validate `C` as
   a commit object before any two-tree diff.
4. Compute `P(B,H)`, `D(C,H)` when applicable, `E`, `X`, and `R`. Validate
   literal paths and the complete run budget before model work. Record scope
   mode, immutable revisions, path counts, excluded paths, and batch coverage
   in bounded run evidence.
5. Run historical-finding verification independently. Run discovery lanes only
   for complete eligible reviewable evidence. Synthesize and gate new findings.
6. Reconcile retained findings and dispositions, derive the cumulative verdict
   mechanically, and validate findings. Finalize execution coverage and finding
   statuses, then seal the run manifest. Pass the immutable scope identity and
   sealed manifest to the publisher under its linked state-machine contract.

No unchecked Git output may become a path, revision, or shell argument. Bounds
on path count, path length, patch size, state size, and model output remain
explicit and tested. A bound reached during eligibility or evidence collection
is an incomplete review, not a smaller valid scope.

## Failure and edge cases

| Case | Required result |
| --- | --- |
| First review, no trusted report | Complete `B...H` baseline. |
| Trusted old-version report | Complete `B...H` baseline; replace old findings, dispositions, metrics, and state. |
| Invalid or unsupported current-version state | Fail closed; preserve the report and checkpoint. |
| Same head reviewed again | Empty `E`; no new IDs. |
| New commit changes one PR file | Review that file's current PR diff; new findings only in that file. |
| Earlier change is reverted before the next review | Restored tree entry is ineligible. |
| Rebase or force-push keeps `C` available | Compare `C` and `H` trees; no automatic baseline. |
| `C` cannot be fetched by exact SHA | Fail closed with the old checkpoint intact; no baseline fallback. |
| Target branch moves or PR is retargeted | Recompute current PR paths; unchanged head files remain ineligible. |
| File leaves the current PR diff | It cannot receive a new finding; retained findings follow lifecycle rules. |
| Path list, patch batch, or state exceeds a bound | Fail without publishing or advancing. |
| Head, target branch, target commit, or checkpoint changes before publication | Treat result as stale; do not publish it. |
| Variant-specific report ID or legacy marker identity changes before publication | Treat result as stale; do not publish it. |
| New finding lacks a path or names a path outside `R` | Reject it before ID allocation and show a scope limitation. |
| Only excluded files change | Do not claim their contents were reviewed or invent a content finding. |
| A planned or dynamic cumulative ceiling is exceeded | Fail without publication or checkpoint advancement. |
| A selected item has no terminal outcome at finalization | Record a typed failure; coverage is incomplete and publication is blocked. |
| A finding cannot be safely located | Preserve it as unlocated or ambiguous with a visible limitation. |
| A later run omits a prior finding's path | Preserve it as `not_reviewed`; do not mark it resolved. |
| An external write has an uncertain result | Re-read and reconcile before retry; do not duplicate or silently drop it. |

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

The state classification in `requirement-scope-selection` governs this path.
In particular, a malformed current-version state must not be relabeled as a
legacy report or replaced by a baseline.

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
- Test complete `-z` path parsing, invalid UTF-8, absolute and traversal
  paths, filenames containing pathspec magic or wildcards, literal argv
  handling, exclusions, batch accounting, and a patch larger than the former
  byte limit.
- Test every cumulative ceiling at its boundary and one unit over it. Prove
  that preflight failures make zero model calls and time or token exhaustion
  cannot publish.
- Test the finalizer with out-of-scope and pathless agent findings. Prove that
  no new stable ID is allocated and a limitation is visible.
- Test a file edited twice: an older PR hunk in that file is context only,
  while a verified C-to-H added or removed line can anchor a new finding.
  Test a zero-hunk tree-entry change, unchanged context lines, changed-line
  range forgery, and a no-change run. No unverified anchor receives a new ID.
- Test that retained findings, dispositions, fix verification, and verdict
  remain correct on both incremental and no-change runs.
- Test old-version replacement, discarded old findings and metrics, old-command
  isolation, invalid-current-state refusal, missing prior commit, tree/blob/tag
  rejection, exact-SHA fetch behavior, and new-baseline versus legacy-replacement
  identity guards.
- Test that v4 remains disposition-only and that v5 is the sole unified schema
  once incremental scope is enabled; no shared-v4 writer or reader is allowed.
- Test failed, cancelled, incomplete, stale-head, moved-target, and
  changed-checkpoint runs. Assert that their authoritative checkpoint does not
  advance.
- Test manifest sealing, idempotent and conflicting transitions, finalization
  backstop failures, per-item versus run-level failure classes, complete
  batch-and-lane membership, deterministic ordering, and independent coverage, finding,
  publication, and admission statuses.
- Test evidence-backed positioning, unlocated and ambiguous findings,
  location-independent deduplication, and `new`, `persisting`, `resolved`, and
  `not_reviewed` comparison outcomes.
- Test reworded summaries, changed recommendations, and moved source with the
  same verified occurrence: retain keys, public IDs, dispositions, and history.
  Distinct supporting contexts stay separate; ambiguous or unsupported
  evidence cannot receive a guessed key. Reject model-supplied keys and
  normalizer drift without requiring a language-specific source parser.
- Test v5 missing or malformed manifest references as `invalid-current`, without
  automatic baseline replacement. Expired artifacts leave a valid Git
  checkpoint intact but disable old audit reads.
- Test rule precedence, exclusion explanations, provenance hashes, the
  single bounded summary, uncertain-write readback, and failed upload.
- Test that a legacy v3 progress marker cannot be parsed as a v5 checkpoint
  and that failed legacy replacement preserves the old report.
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
- A legacy replacement carries and revalidates its prior report ID and marker
  identity; a new baseline requires the authoritative report to remain absent.
- V4 is disposition-only; V5 is the sole current schema when incremental scope
  is enabled.
- Malformed or unsupported current-version state cannot trigger baseline
  replacement or erase the prior report.
- A later publication allocates no new finding ID outside
  `(P(B,H) ∩ D(C,H)) - X`.
- Git pathspec syntax cannot widen a scoped diff, and excluded paths cannot
  receive new findings.
- Re-running an unchanged head allocates no new finding ID.
- Previously published findings remain visible and can change lifecycle only
  through existing verification and disposition rules.
- No failure, stale result, or partial evidence advances the checkpoint.
- A moved target branch or base commit invalidates the in-flight scope before
  publication, even when the head SHA is unchanged.
- No cumulative resource ceiling can be bypassed by adding batches or retries.
- Rebase, force-push, and base movement do not silently reopen full-branch
  discovery.
- Every selected item has one explicit outcome in an immutable versioned
  manifest, and missing outcomes become visible failures.
- Findings retain typed bounded evidence, safe location status, and identity
  independent of line location.
- Comparisons preserve `not_reviewed`, and coverage, finding, publication, and
  admission statuses cannot collapse into one completion flag.
- The human report identifies the review mode and scope and does not present
  incremental ratings as a fresh full-branch review.

## Delivery state

This specification defines intended behavior. The current implementation
still supplies the full `baseRevision...headRevision` patch on every run and
does not gate new findings by a published checkpoint.

## Traceability

- State, lifecycle, and publication: [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- Manifest and provenance: [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md)
- Action boundary: [spec.direct-runtime-code-review-action](./2026-09-08-direct-runtime-code-review-action.md)
- Related draft disposition proposal: [spec.mechanical-pull-request-review-dispositions](./2026-09-06-mechanical-pull-request-review-dispositions.md)
- Delivery: [task.incremental-pull-request-review-scope](../tasks/2026-09-13-incremental-pull-request-review-scope.md)
