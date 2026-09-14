---
id: spec.versioned-pull-request-review-comments
title: Versioned Pull Request Review Comments
status: active
owners:
  - core
created: 2026-09-05
updated: 2026-09-14
upstream: []
supersedes: []
---

# Versioned Pull Request Review Comments

## Summary

The pull-request review example publishes one trusted comment for each pull
request. The comment separates the human review from the persisted review
state.

## Goals

- Give reviewers a short and stable human review.
- Preserve bounded lifecycle state between review runs.
- Prevent an old run from replacing a review for a newer head revision.
- Give each finding one stable publisher-owned identifier.
- Preserve human dispositions without treating a claim as verified evidence.
- Show when a new review is refreshing an existing authoritative comment.
- Preserve deterministic per-run task cost and usage metrics for reviewers.

## Non-goals

- Execute pull-request code, tests, builds, scripts, or checks.
- Store patches, credentials, or secret values in the GitHub comment.
- Replace internal ratings, evidence, or observability data.
- Define a public Seqlane package contract.

## Terminology

- **Authoritative comment:** The trusted bot comment that owns the review state.
- **Human projection:** The concise Markdown review that people read.
- **Review state:** The validated machine data that the next review consumes.
- **Run metrics ledger:** The one human-readable, strict JSON object in the
  authoritative comment that retains completed review-run metrics.
- **Comparable predecessor:** A prior reviewed revision that Git identifies as
  an ancestor of the current reviewed revision.
- **Disposition:** An authorized human decision, such as `wont-fix` or
  `downgrade`.

Review-scope selection and checkpoint advancement are defined in
[spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md).
The version 3 state below is historical transport and lifecycle input. The
current strict state revision is v5 and adds that spec's scope checkpoint
without changing trusted-comment or run-metrics ownership here.
The incremental-scope specification owns `E`, `X`, `R`, and checkpoint
semantics. [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md)
owns manifest schema, persistence, coverage, and provenance. This specification
owns trusted state, the publication state machine, and its publication journal.

## Requirements

### requirement-trusted-authority

The publisher must read and update comments from the configured bot identity
only. The marker must contain the schema version, pull-request number, and full
reviewed revision.

### requirement-publication-order

The publisher must read the live pull-request state before each write. The
pull request must remain open and eligible. Its head revision must equal the
report revision.

### requirement-publication-state-machine

The Action-library publisher is the sole owner of publication state. The
scope selector and review lanes produce data; they do not write GitHub state.
Publication follows one canonical state machine:

```text
prepared
  -> progress-marked
  -> inline-reconciled
  -> finalizable
  -> published

prepared | progress-marked | inline-reconciled | finalizable
  -> stale | cancelled | failed

prepared | progress-marked | inline-reconciled | finalizable
  -> uncertain(lastConfirmedStage, operation)

uncertain
  -> confirmed successor stage   [exact write match]
  -> lastConfirmedStage          [write proven not applied; guards still pass]
  -> stale                       [publication identity changed]
  -> uncertain                   [effect remains unknown]
```

`uncertain` preserves the durable intent, operation identity, payload digest,
and last confirmed stage. The successor is the stage reached by that specific
operation, including `published` for a confirmed final write. An inline write
may return to `progress-marked` while other inline operations remain pending.
Retry is permitted only after proving the original write was not applied and
returning to its prior stage; it reuses the same logical operation identity.
An absent or mismatched read alone is not proof that an in-flight write failed.

If reconciliation exhausts its budget or the job is cancelled while the effect
remains unknown, preserve `uncertain` in the journal for later recovery. Cleanup
may remove an owned progress notice only after proving it will not overwrite
a final report. It cannot erase the intent, mark publication failed merely
because a response was lost, or advance a checkpoint. After reconciliation
restores a nonfinal stage, ordinary failed/cancelled transitions and cleanup are
legal. Stale attempts preserve their evidence without further publication.

The first summary write is progress-only: it prepends an owning-run notice and
retains the previous authoritative state block, findings, and checkpoint. It
must not expose candidate findings or a new checkpoint. Scope selection ignores
that notice and any pending publication record. Inline comments emitted before
the final write carry the owning run and a `pending` marker; they are secondary,
non-authoritative projections. The final summary write is the only commit point
that exposes the new findings, scope checkpoint, and complete human projection.
It records publication counters, limitations, fallback findings, and terminal
statuses. If that write fails, the old state remains authoritative and pending
projections cannot advance the checkpoint.

Every publication operation carries a typed identity containing the pull request,
scope identity, run ID, attempt, stage, and canonical payload digest:

```text
PublicationOperation = {
  pullRequestNumber
  scopeIdentity
  runId
  attempt
  stage: "progress-summary" | "inline-finding" | "final-summary"
  payloadDigest: lowercase SHA-256
}
```

To avoid self-referential hashes, `payloadDigest` hashes the canonical report or
inline payload with only its operation marker and journal-intent reference
omitted. It still covers findings, statuses, checkpoint, execution reference,
and human projection. Readback uses this same projection and separately verifies
the omitted identity fields against the durable intent.

An inline finding additionally includes its finding ID and evidence-head
revision. The publisher persists stage transitions in the publication journal.
It accepts an idempotent retry only when the stage and payload digest match.
Before retrying an uncertain write, it re-reads the live summary or inline comment and
treats an exact operation identity and content match as success. It never
creates a duplicate or deletes historical comments. A changed head, target,
checkpoint, report identity, or scope identity transitions the operation to
`stale`.

### requirement-publication-coordinator

All writes by the review bot for one pull request, including progress, inline
findings, final summary, and cleanup, require one Action-owned publication
lease. The coordinator is a DynamoDB table in one region; it stores only bounded
lease, journal-head, and capacity metadata, never findings or patches. A
conditional `PutItem` creates the per-PR lease row when absent. Conditional
`UpdateItem` compares its revision and owner before acquisition or release.
The lease owner is the trusted workflow run ID, attempt, and a unique fencing
nonce. The workflow gives coordinator permission only to the trusted Action
adapter and publisher; review-target code and model work receive none.

The lease does not expire into another active writer. A takeover requires the
previous GitHub workflow run to be verifiably terminal, followed by a
conditional owner/revision update. An unverifiable owner blocks publication.
Before every GitHub write, the publisher checks its lease and re-reads the live
PR and trusted report under that lease. Every allowed bot publication path must
use this coordinator; a bypass is a configuration failure. The publisher keeps
the lease through write reconciliation and the durable journal receipt. A
lost lease or failed coordinator read stops new writes and leaves an uncertain
write for recovery. A runner cannot continue writing after another owner takes
over because takeover waits for its verified termination.

The live report precondition is a strict union:

```text
ReportPrecondition =
  | { kind: "absent"; pullRequestNumber; scopeIdentity; runId; attempt }
  | { kind: "present"; reportId; markerDigest; stateDigest;
      pullRequestNumber; scopeIdentity; runId; attempt }
```

For a new baseline, acquire the lease, confirm `absent` in a fresh trusted
comment read, and durably journal an intent with that exact precondition before
creating the summary. This is the create-if-absent operation: the lease makes
the absence check and creation exclusive among authorized bot writers. An
already present authoritative comment produces `stale`; the publisher must
not create a second one. An uncertain create is reconciled by exact operation
identity and payload before retry. For existing reports, `present` guards every
summary update and cleanup against the current report ID and content digest.
After each confirmed summary write, replace the local precondition with the
validated returned ID and digest. Inline writes do not alter that report
precondition, but their own comment IDs and payload digests are reconciled and
the live report is re-read before the next write. Re-read and validate the
current report immediately before final publication. A mismatch is `stale`;
an unknown write effect is `uncertain`. Journal the precondition and each
confirmed successor so retries do not reuse a token from before a progress
write. No progress marker or inline operation can advance the checkpoint.

GitHub's issue-comment endpoints do not document conditional `POST` or `PATCH`
writes. This contract therefore uses an exclusive trusted writer, not a
fictional GitHub ETag precondition. Its guarantee covers the configured review
bot. A writer using the bot credential outside the coordinator violates the
trust boundary and cannot be made atomic by read-before-write checks. The
workflow must withhold that credential from bypass paths and fail deployment
checks if any bot writer is not routed through this lease.

Publication is complete only when coverage is complete, finding validation is
complete, the authoritative summary is written, and every admitted finding is
either inline-published or represented in the final summary fallback. An
unresolved inline write, missing fallback, or failed final summary update makes
publication incomplete (`uncertain` or `failed`) and blocks checkpoint advancement.
The scope checkpoint, retained findings, visible limitations, and publication status are one final
authoritative write. Checkpoint advancement is allowed only from `published`.

### requirement-publication-journal

The publisher owns an append-only `review.publication-journal/v1` journal.
The Action artifact adapter persists immutable journal snapshots under the
manifest's trusted repository, workflow, access, redaction, and retention
boundary. Each entry contains journal run ID and attempt, monotonic sequence,
previous-entry digest (null only at sequence zero), `PublicationOperation`,
publication stage, `ManifestReference`, and an outcome of `intent`, `confirmed`,
`unknown`, or `failed`. Confirmed writes also record the GitHub comment ID and
validated payload digest. Each entry carries `RunStatus`, validated against its
execution snapshot and the transition rules below. A journal reference contains
repository, workflow run and attempt, artifact ID, journal run ID, schema version,
sequence, and SHA-256 digest. Missing entries, invalid transitions, or digest
mismatches fail closed. Each snapshot has a canonical SHA-256 digest.

The lease also serializes each journal's append. Its coordinator row stores the
active journal ID, head sequence, head digest, and owner nonce. To append, the
publisher first uploads a uniquely named immutable candidate snapshot and
verifies its artifact ID, bytes, digest, and previous head. It then atomically
updates the row only if owner, journal ID, head sequence, and head digest still
match. This conditional update is the commit of the next sequence. A conflict
must re-read the row and artifacts: an exact already committed candidate is
idempotent; another digest or missing artifact is a fork/integrity failure.
Do not send an external write until its intent is the committed head. An
uncommitted candidate is an orphan, never evidence of an operation.

After a crash or uncertain receipt, a new verified lease owner starts a new
journal attempt with a `parentJournalReference` to the last validated head.
It cannot append to or rewrite the old attempt. It first reconciles any
committed external-write intent against live GitHub state. If a receipt append
conflicts after an external write, preserve the committed intent and stop;
recovery in the new attempt can record the exact confirmed result. Unknown
effects never become success by advancing a journal pointer. The publisher
keeps capacity for intent, receipt, and recovery before starting a write.

Persist an intent before a GitHub write; append its confirmed receipt or bounded
failure afterward. Journal entries reference execution snapshot digests in one
direction. Early progress entries may reference the initial execution snapshot;
inline and final entries must reference the final sealed execution snapshot.
They cannot change execution items, findings, statuses, or manifest digests.
Reserve journal capacity before writes within the manifest's existing aggregate
limits. A journal snapshot is limited to 256 entries and 512 KiB uncompressed;
reserve room for uncertain-write reconciliation and the terminal receipt.
Capacity exhaustion stops further writes and leaves the attempt unconfirmed.

The final comment binds the sealed execution reference and the durable journal
intent reference. It cannot embed its own receipt digest: the receipt follows
the GitHub commit point. On a crash or failed receipt write, recovery reads the
live comment and verifies the exact operation identity, references, and payload.
An exact match permits appending the missing receipt without another GitHub
write. A mismatch remains uncertain or stale under the publication guard;
it cannot be called successful. Losing a receipt does not undo a confirmed
authoritative write or manufacture a second checkpoint advancement.

The audit result joins the sealed execution digest with the latest verified
journal digest. Neither digest requires mutation of the other artifact. The
journal cannot replace the publication lease and live-report guards above.

### requirement-run-status-gates

One strict schema defines the joined run status. Unknown enum values, missing
dimensions, or inconsistent combinations are invalid; no consumer may infer
them from a summary, verdict, or a generic success flag.

```text
RunStatus = {
  coverage: "pending" | "complete" | "incomplete"
  finding: "pending" | "valid" | "invalid"
  publication: "not-started" | "in-progress" | "published"
             | "uncertain" | "failed" | "cancelled" | "stale"
  admission: "blocked" | "admissible"
}
```

The manifest finalizer owns `coverage` and `finding`. Before sealing, coverage
changes once from `pending` to `complete` or `incomplete`; finding changes once
from `pending` to `valid` or `invalid`. Finding validity requires schema,
evidence, identity, history, disposition, and cumulative-verdict validation.
Incomplete validation becomes `invalid`, never an implicit success. These
dimensions cannot change after sealing.

The publisher owns `publication` in the journal. `prepared` maps to
`not-started`; `progress-marked`, `inline-reconciled`, and `finalizable` map to
`in-progress`. The matching terminal stages map to `published`, `failed`,
`cancelled`, or `stale`. A write with unknown effect maps to `uncertain` and
retains its last confirmed stage. Only exact reconciliation can restore that
stage or confirm the next one; no later write may bypass uncertainty. A failed,
cancelled, or stale attempt cannot restart; retry uses a new attempt identity.
The same execution reference may be reused only if all publication guards hold.

The publisher derives `admission` mechanically from the following matrix.
`admissible` means consumers may accept the completed review result. It does
not mean merge approval: a valid review can still request changes.
All final-publication rows also require execution outcome `complete` and live
publication guards. Any other execution outcome blocks final publication and
admission, even if its individual coverage and finding dimensions succeeded.

| Execution and publication state | Permitted action | Checkpoint | Admission |
| --- | --- | --- | --- |
| Execution pending; guards pass | Progress notice retaining prior authoritative state | Preserve | `blocked` |
| Sealed `complete` / `valid`; `not-started` or `in-progress`; guards pass | Progress and inline reconciliation; final write only at `finalizable` | Preserve until final write succeeds | `blocked` |
| Sealed `complete` / `valid`; final write confirmed, all findings inline or fallback | Record `published` and accept final state | Advance atomically with final comment | `admissible` |
| Either execution dimension incomplete, invalid, or pending at finalization | Failure reporting or progress cleanup only | Preserve | `blocked` |
| Any `uncertain`, `failed`, `cancelled`, or `stale` publication | Reconciliation or cleanup only | No new advancement | `blocked` |

The final payload carries `published` / `admissible` as the postcondition of its
successful guarded write. Constructing that payload is not publication success.
There is no requirement to be published before attempting the final write.
After an uncertain final write, the previous checkpoint remains the last locally
confirmed checkpoint until exact readback establishes which state is live.
The final write is the only authority transition; a later journal receipt
confirms that event. Prior published results remain historical evidence when a
new attempt starts with `not-started` / `blocked`.

### requirement-state-contract

The authoritative comment must contain exactly one metadata marker and one
bounded state block. A strict Zod schema must validate the decoded state before
use. The state identity must match the metadata identity.

The state must contain these fields:

- schema version;
- pull-request number;
- base and reviewed revisions;
- comparable predecessor revision, when available;
- the next finding index;
- retained findings, typed finding identity, canonical `identityKey` and
  `occurrenceKey`, and lifecycle metadata;
- review limitations;
- comparison outcomes for retained findings;
- the strict joined `RunStatus`;
- the required final sealed `ManifestReference`, including artifact identity,
  snapshot sequence, and SHA-256 digest;
- the required publication journal intent reference and digest.

The current state contract is version 5. Its strict envelope and marker must
agree on `schemaVersion: 5` and must contain the scope checkpoint, generation-
qualified finding IDs, typed comparison outcomes, publication status, and
manifest reference defined by the linked specifications. The v3 state and
numeric finding IDs described below are legacy input only; they are never
written as the current state after scope-capable delivery. V4 is a
disposition-only transitional state and is also never an incremental
checkpoint.

A v5 reference must match the report's repository, pull request, reviewed
revision, run, and scope identity. Missing or malformed manifest references or
digests classify the report as `invalid-current` and fail closed. They never
select legacy replacement or an automatic baseline. Artifact expiry disables
resume reuse, as defined by the manifest specification; it does not erase a
structurally valid reference or reset the published Git checkpoint.

### requirement-run-status-and-metrics

When a new eligible review starts and a trusted authoritative comment already
exists, the workflow must prepend a prominent, machine-detectable in-progress
notice to that comment. The notice must be removed after the new report is
published. Cleanup must also remove it when execution fails or is cancelled so
an interrupted run cannot leave a stale status.

The publisher must mechanically derive one metrics object for each completed
review run from the serialized execution events. Each task entry must include
the task identity, result state, duration, and any available model, provider,
token, and cost values. The object must include run duration, total cost, and
token totals. The publisher must not use an agent to calculate or interpret
these values.

The authoritative comment must contain exactly one marked, human-readable run
metrics ledger. The ledger is a plain JSON object with a schema version and a
`runs` array. Every run entry must contain the GitHub workflow run ID, attempt,
completion time, reviewed revision, and the mechanically derived metrics
object. The run ID and attempt form the entry identity. A new run appends one
entry unless that identity already exists. Missing provider metrics must remain
absent rather than being represented as fabricated zero usage.

The ledger is the only source for rendered run metrics. The human projection
may calculate total pull-request cost, last-run cost, and run count from
`runs`, but it must not persist those derived values in the ledger. The
publisher must not create or read separate per-run audit comments.

The reader must strictly validate the marked ledger independently of review
state. A missing, malformed, unsupported, or legacy ledger is an empty ledger.
It must not cause the publisher to discard the otherwise valid review state,
findings, or lifecycle data. No metrics-ledger migration or recovery path is
required.

Before publication, the publisher must re-read the current trusted report and
skip a stale write when its run metadata no longer matches the report read at
review start. Ledger updates must be idempotent by run ID and attempt.

### requirement-stable-identity

The local finalizer owns final finding identifiers. A new identifier uses the
format `SEQ-PR{number}-{index}` with a three-digit minimum index.

The finalizer must not reuse an index. A retained or reopened finding keeps its
identifier. Review agents can reference prior identifiers but cannot allocate
new final identifiers.

Each retained finding stores its typed identity, canonical location-independent
`identityKey`, and semantic `occurrenceKey` under the
[scope identity algorithm](./2026-09-13-incremental-pull-request-review-scope.md#requirement-new-finding-admission).
Equal pairs identify duplicates only after local evidence confirms the same
occurrence. Distinct or ambiguous occurrences retain independent evidence,
lifecycle status, dispositions, and comparison outcomes even when prose matches.

The finalizer must collapse duplicate temporary and legacy identifiers before
it assigns stable identifiers. Legacy deduplication must mark the state as
truncated and add a limitation.

The incremental-review scope contract uses generation-qualified IDs for new
baseline reports. This prevents a disposition aimed at an older report from
applying to a new finding after that report is replaced. The numeric format
above remains a version 3 legacy input contract only.

### requirement-lifecycle

Each retained finding has one lifecycle status:

- `new`: the current review detected the finding for the first time;
- `open`: the current review detected an active prior finding;
- `addressed`: an authorized fix claim exists, but verification is incomplete;
- `resolved`: current-head verification found that the problem is absent;
- `reopened`: the current review detected a previously resolved finding;
- `dismissed`: an authorized decision accepts the finding or rejects its
  applicability.

A downgrade changes effective severity. It does not dismiss the finding.
Command names and finding identifiers are case-insensitive.

Each retained finding also has a separate typed `comparisonOutcome` with one of
`new`, `persisting`, `resolved`, or `not_reviewed`. This field is stored in the
validated state and rendered in the human projection; it does not replace
lifecycle status, severity, or disposition. `not_reviewed` is assigned when the
later run omits the finding's path from its reviewable scope and cannot change
the lifecycle or imply resolution. `resolved` and `reopened` require
current-head verification under `requirement-fixed-verification`. Authorized
dispositions remain authoritative when comparison output is merged.

### requirement-fixed-verification

A `/seqlane fixed` command is a claim and sets an unresolved finding to
`addressed`. A separate review task must inspect each claimed fix against the
current head.

The task must return a typed result for each inspected finding. Each result
must contain the finding identifier, head revision, outcome, and bounded
evidence.

Only a `resolved` result for the current head can set the finding to
`resolved` or keep it resolved. A missing, stale, or uncertain result keeps the
finding active. Removing or retargeting the authorizing disposition reopens a
previously resolved finding, even when current-head verification reports that
the original implementation is absent.

An edited comment triggers review only when its current or previous body has a
recognized command. This permits command removal without running reviews for
unrelated comment edits.

Comment collection must preserve recognized command lines even when it bounds
the surrounding comment body. It must retain the latest commands before
optional context when it applies the final comment bound. It must mark history
as truncated if older command lines do not fit. The collector must enforce one
aggregate command-count and text budget across the retained history. Before it
applies that budget, it must retain only the latest command for each finding
and authorization class. The collector must mark each comment that loses a
command to the aggregate budget. Lifecycle reconciliation must preserve a
prior disposition when its authorizing comment has this marker. It must still
reopen the finding when the command was removed or retargeted without
projection loss.

### requirement-human-projection

The human projection must show the verdict, active counts, reviewed revision,
and one findings table. It must not render slash-command syntax. It must show
plain Markdown sections for active Critical and Required findings. Each section
must show the finding ID, severity, area, location, explanation, and
resolution.

Severity and lifecycle labels must use the emoji vocabulary from the source
review template.

The projection can omit internal ratings and run evidence. It must show a
deterministic limitation notice when retained evidence or history is
incomplete.

The projection shows at most 20 retained findings and 10 verification entries.
The state block retains the complete bounded state when the projection omits
items.

The projection must neutralize model-controlled text before Markdown renders
it. Active Critical and Required findings must remain visible before inactive
history when the projection reaches its limit.

### requirement-bounds

The state and human projection must have explicit size and item limits. The
retention policy must keep active blockers before non-blocking or inactive
findings.

The publisher must reject an oversized final comment. Snapshot decompression
must stop at the configured output limit.

If the publisher compacts state, it must add the compaction limitation to the
persisted state and the human projection in the same publication.

The workflow must pass bounded review input through a file. It must not place
the complete comment history in one command-line argument.

### requirement-review-boundary

The final note must state that the review agents did not execute pull-request
code, tests, builds, scripts, or checks. The note must not claim that the
workflow performed no Git operations.

### requirement-workflow-admission-and-concurrency

The workflow must admit an event before it enters the shared per-pull-request
concurrency group. The admission job must not check out source or receive
write permissions. It must admit non-closed `pull_request_target` events only
for non-draft pull requests whose head repository is the current repository. It
must admit `workflow_dispatch` only when a pull-request number is present. It
must admit `issue_comment` only for pull requests, created or edited comments,
and `OWNER`, `MEMBER`, or `COLLABORATOR` authors whose current or previous body
contains the recognized `/seqlane review`, `/seqlane fixed`, `/seqlane wont-fix`,
or `/seqlane downgrade` command under the existing command-matching rules.

Only admitted review jobs may use the `seqlane-code-review-<pull-request>`
concurrency group with `cancel-in-progress: true`. An irrelevant or
unrecognized comment must not enter that group, cancel an active review, or
queue behind one. A closed `pull_request_target` event must run a separate
no-op cancellation job in the same group so it interrupts active review work
without starting review or publisher steps.

## Detailed design or contracts

The state block uses schema version 3. The publisher places the state in a
collapsed Markdown details element after the human projection.

The state payload uses compact JSON. The publisher can use a bounded
`gzip+base64` wrapper when direct JSON exceeds the state budget.

The run metrics ledger uses a separate, visible Markdown code block with
start/end markers. Its JSON shape is:

```json
{
  "schemaVersion": 1,
  "runs": [
    {
      "githubRunId": "string",
      "attempt": 1,
      "completedAt": "RFC 3339 timestamp",
      "reviewedRevision": "full Git revision",
      "metrics": {}
    }
  ]
}
```

The ledger must satisfy the existing final-comment byte limit. The publisher
must reject an oversized ledger rather than silently dropping retained runs.
The previous v3 `run`, `runs`, and `runSummary` state fields are not inputs to
the ledger and are not migrated.

Run timestamps and identifiers are audit data. They do not decide publication
order across revisions. The live pull-request head and full Git revisions
decide eligibility. For the same reviewed revision, the GitHub run ID and
attempt prevent an older run from replacing a newer publication. Admitted
review jobs cancel older runs for one pull request so only the latest run can
publish. A closed pull-request event uses a separate no-op job in that same
group to interrupt active review work without starting review steps.
Progress-marker cleanup is scoped to the owning run so an older cancelled run
cannot remove a newer run's notice. Irrelevant comments do not enter the
concurrency group.

The human status and severity labels are deterministic projections of the
validated state. Model output cannot select the final verdict or active
counts.

## Failure and edge cases

- Ignore state from an untrusted comment author.
- Ignore malformed, oversized, or unsupported state.
- Treat a missing, malformed, oversized, or unsupported run metrics ledger as
  an empty ledger without discarding valid review state.
- Reject a publication that would make the visible run metrics ledger exceed
  the final-comment byte limit.
- Do not publish when the live pull request is closed, draft, or ineligible.
- Do not publish when the live head differs from the report head.
- Do not show a predecessor or delta when Git ancestry is not comparable.
- Keep a claimed fix active when verification is absent or uncertain.
- Keep all retained blocking findings before lower-priority history.
- Do not let an irrelevant issue comment cancel or queue an active review.

## Migration

The reader accepts legacy v1 through v4 snapshots only to classify and replace
them. The first scope-capable publication writes the unified v5 state and a
fresh baseline; it does not migrate old findings, dispositions, metrics, IDs, or
checkpoints. V3 numeric identifiers and v4 disposition fields remain legacy
input and are never written as the current incremental state.

## Verification

- Add schema compatibility and malformed-state tests.
- Reject v5 state without a valid manifest reference and digest; distinguish
  that failure from artifact expiry with a valid published checkpoint.
- Test every run-status gate, including valid request-changes results,
  incomplete coverage, uncertain final writes, and failed publication.
- Test journal intent/receipt ordering and crash recovery before and after the
  final GitHub write; sealed execution bytes must remain unchanged.
- Test absent-report lease acquisition by two baseline runs, progress-to-final
  precondition refresh, changed report content, and lost lease. Exactly one
  authoritative bot comment may be created; conflicts keep the old checkpoint.
- Test concurrent journal append candidates, owner takeover only after run
  termination, orphan artifacts, head conflicts before and after a GitHub
  write, and exact recovery from a committed intent.
- Test uncertain transitions for exact success, proven non-application, changed
  identity, repeated unknown effects, and cancellation during reconciliation.
  Retry must retain operation identity; unknown effects cannot advance the
  checkpoint or permit destructive progress cleanup.
- Add lifecycle transition and stable-identifier tests.
- Add current-head fix-verification tests.
- Add trusted-author and stale-head publication tests.
- Add workflow admission and concurrency regression tests.
- Add ledger parsing, malformed-ledger, duplicate-run, and rendered-derived
  cost tests.
- Execute the exact publisher script with bounded representative state.
- Run the branch workflow against an open pull request.

## Acceptance criteria

- The comment contains a concise human projection and one bounded state block.
- The next review restores validated state from the trusted bot comment.
- Stable finding identifiers survive open, resolved, and reopened transitions.
- A fix claim cannot resolve a finding without current-head verification.
- An old or untrusted run cannot replace the authoritative comment.
- Mandatory limitation notices remain visible after output bounds apply.
- The authoritative comment contains one strict, human-readable run metrics
  ledger and no per-run audit comments.
- A legacy or invalid ledger starts a fresh metrics ledger without changing the
  valid review state.
- Irrelevant comments cannot enter review concurrency, while recognized
  commands and pull-request updates remain serialized per pull request.

## Traceability

- Source proposal: [Seqlane review template](https://github.com/marcolink/seqlane/issues/45)
- Review scope: [spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Execution evidence: [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md)
- Coordinator guarantees: [DynamoDB conditional writes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html) and [transactions](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html); [GitHub REST conditional-request limits](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- Delivery: [task.publish-versioned-pull-request-review-comments](../tasks/2026-09-05-publish-versioned-pull-request-review-comments.md)
- Delivery: [task.prevent-comment-triggered-review-cancellation](../tasks/2026-09-05-prevent-comment-triggered-review-cancellation.md)
- Delivery: [task.consolidate-pull-request-review-run-metrics](../tasks/2026-09-06-consolidate-pull-request-review-run-metrics.md)
