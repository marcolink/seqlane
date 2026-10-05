---
id: spec.versioned-pull-request-review-comments
title: Versioned Pull Request Review Comments
status: active
owners:
  - core
created: 2026-09-05
updated: 2026-10-05
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
- Verify retained findings against the current head without trusting comments as decisions.
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
- **Run metrics ledger:** The current v4 comment's visible strict JSON object
  that retains completed review-run metrics.
- **Comparable predecessor:** A prior reviewed revision that Git identifies as
  an ancestor of the current reviewed revision.

Issue and review comments are untrusted context. They do not trigger reviews
or change finding status or severity.

Review-scope selection and checkpoint advancement are defined in
[spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md).
The version 4 state describes the current command-free transport and lifecycle
contract. The incremental-scope target is a new strict v5 revision.
It adds the scope checkpoint and uses the publication draft's hidden transport
and cost projection. Detailed execution metrics belong to the manifest.
The incremental-scope specification owns `E`, `X`, `R`, and checkpoint
semantics. [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md)
owns manifest schema, persistence, coverage, and provenance. This specification
owns trusted state and final report publication. No external coordinator or
publication journal is required for the v5 review path.

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
For the planned v5 path, publication has one GitHub write.
It creates or updates the authoritative summary after execution and sealing.
The final body contains findings, limitations, published cost, status, and
the new checkpoint. There are no pre-publication progress writes or inline finding
writes in this iteration. The workflow job and step summary show progress
without changing the authoritative comment. The current v4 owning-run notice
remains legacy behavior until the v5 path is delivered.

The publisher records publication as not-started before the final write and
published only after an exact response or readback confirms it. A changed live
head, target, report, or checkpoint is stale; a known failed write is failed.
An ambiguous API result is uncertain: the publisher re-reads the trusted
comment and accepts only an exact operation identity and payload match. It
does not issue a second write while the first may still complete. An
unconfirmed run cannot claim success. A later run reads the live trusted report
before selecting scope.

This specification owns the strict publication operation model:

```text
PublicationOperation = {
  schemaVersion: 1
  writerKind: "full-review"
  pullRequestNumber: positive integer
  stateRevision: positive integer
  writerRunId: decimal GitHub workflow run ID, at most 128 bytes
  writerAttempt: positive integer
  source: {
    kind: "review"
    sourceRunId: decimal GitHub workflow run ID, at most 128 bytes
    sourceAttempt: positive integer
    scopeIdentityDigest: lowercase SHA-256
  }
  payloadDigest: lowercase SHA-256
}
```

IDs are nonzero decimal strings. Unknown fields fail validation.
The publisher derives every identity from trusted workflow input.
An absent or replaceable legacy report has predecessor revision zero.
The new `stateRevision` is that live predecessor revision plus one.
No comment-command writer exists.
The canonical final body omits only `payloadDigest` for hashing. The operation
identity remains inside those hashed bytes. The publisher then inserts the
digest and renders the final body. Readback repeats that calculation.
An exact readback match for the current writer is idempotent evidence of its
write; a mismatch cannot be treated as success. The report itself is the
durable publication record. No separate intent or receipt store is required.

### requirement-serialized-publication

Only full-review publishers write the authoritative comment. Every publisher
uses the case-normalized key `seqlane-review-publication-<repository-id>-<pr-number>`.
The group uses `queue: max` without `cancel-in-progress: true`.
GitHub permits 100 pending jobs and orders them by queue-entry time.
Dispatch order is not publication order. Overflow cancels the additional job.
Queue admission is not durable delivery. Recovery follows the next requirement.
Review computation remains outside this queue and can cancel older computation.

After queue admission, the publisher re-reads the live PR and trusted report,
then compares them with the captured ScopeIdentity. A new baseline requires
no authoritative report. Legacy replacement requires the captured report ID
and marker digest. Incremental and no-change modes require the captured
report ID, state digest, and checkpoint. Any mismatch is stale and makes no
write. For an existing report, the final update must use the same trusted
comment ID; it never deletes historical comments. For an absent report, the
queued publisher first proves unique absence and clears all earlier attempts
under the recovery gate. Only then can it create the authoritative comment.
Multiple matching comments or incomplete authority lookup block every write.

GitHub issue-comment POST and PATCH have no general conditional-write
guarantee. The queue serializes configured bot writers, while the live read
rejects stale work. It cannot protect a writer that bypasses the queue or
guarantee that an ambiguous HTTP request has stopped on job termination. Bot
write credentials must be unavailable to bypass paths and review-target code.
No DynamoDB, external lease, capacity table, or IAM role is part of this
contract. Publication is complete only when the one bounded summary contains
all admitted findings and the final write is confirmed. The checkpoint,
findings, limitations, and publication status change in that one body.

### requirement-publication-recovery

The sealed candidate and its verified
[ReviewPublicationLink](./2026-09-14-github-native-review-publication.md#requirement-final-publication)
bind the source review to its producer, artifact, and registered publisher.
Registration occurs before the publisher enters the queue. An absent report
alone never proves that an earlier POST failed. Job termination, timeout,
artifact expiry, or a missing registration cannot clear an unknown write.

Before any create or update, the publisher inspects earlier registered writers
for that PR through the trusted workflow and artifact lookup.
A writer that sent, may have sent, or can still complete a request blocks
publication, even for a newer head.
A registered job waiting in the same queue has not sent its request.
It cannot write concurrently and does not block the current queue holder.
Recovery cannot replace its registration while that job can still start.
An exact comment ID, complete body, operation, and artifact-reference match
confirms publication. A readback mismatch or absent comment does not confirm
non-application. Incomplete inspection fails closed and reports the unresolved
source and writer identities. It preserves the prior checkpoint.

The default-branch reconciler handles `workflow_run: completed` events and a
bounded scheduled sweep. It validates repository, allowlisted workflow ID and
definition, run, attempt, PR, artifact, and registered publisher before action.
It never executes PR code or artifact content. The storage draft owns the
bounded lookup, registration, and sweep cursor. This section owns replay safety.

Recovery replays a verified sealed candidate only after proving its earlier
publisher never entered the write step or failed definitively before sending.
It retains source run, attempt, scope, and artifact identity and registers a
new writer attempt. It uploads no second review manifest. The replay enters
the same queue and repeats all live guards. A stale candidate makes no write.
A confirmed consumed source is a no-op. Duplicate dispatches and cancelled
replays follow these same rules. Unknown effects remain blocked for independent
reconciliation. They never become retryable through elapsed time alone.

Cancellation before verified candidate upload has no recoverable publication.
Cancellation after upload can recover the same candidate, even if dispatch
never occurred. Queue overflow and recovery failure remain visible in Actions.
Neither an incomplete admission nor a failed recovery claims publication.

### requirement-publication-permissions

The workflow uses separate jobs with explicit job-level `permissions`.
Unlisted GitHub token permissions are `none`. The required token scopes are:

| Job | GitHub token permissions | Credential boundary |
| --- | --- | --- |
| Review computation and trusted candidate upload | `contents: read`, `actions: read`, `pull-requests: read` | No PR, comment, or dispatch write. Only the trusted upload adapter receives artifact runtime credentials. |
| Candidate dispatch | `contents: read`, `actions: write`, `pull-requests: read` | Dispatches only validated candidates. No model work or comment write. |
| Publisher registration | `contents: read`, `actions: read`, `pull-requests: read` | Trusted runtime capability uploads registration and index artifacts. No model work or comment write. |
| Final publisher | `contents: read`, `actions: read`, `pull-requests: write` | Reads verified artifacts and writes the one bot comment. No PR checkout, model work, or artifact upload. |
| Recovery inspection | `contents: read`, `actions: read`, `pull-requests: read` | No dispatch, deletion, or comment write. |
| Recovery dispatch and cleanup | `contents: read`, `actions: write`, `pull-requests: read` | Acts only on validated inspection output. Trusted runtime capability updates the cursor and index. No comment write. |

Artifact upload uses the trusted job's separate Actions runtime capability.
`actions: write` is not required on the computation job's GitHub token.
PR content is review data. Computation does not execute PR code.
Model workers run with an explicit environment allowlist and isolated storage.
They receive neither `GITHUB_TOKEN` nor Actions runtime credentials, endpoint
variables, credential files, or access to the upload adapter.
Publisher and recovery code comes from the trusted default-branch definition.
Workflow tests must prove these boundaries and reject broader inherited scopes.
The producer's dispatch step and publisher registration run in their own jobs.
Recovery inspection passes a validated plan to the recovery writer job.

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
evidence, identity, history, and cumulative-verdict validation.
Incomplete validation becomes `invalid`, never an implicit success. These
dimensions cannot change after sealing.

The publisher owns publication. Before its one final GitHub write it is
not-started. A confirmed exact write or readback makes it published. A known
failed write is failed; a live-identity mismatch is stale; an ambiguous
response without exact readback is uncertain. Cancellation before publication
is cancelled. A terminal attempt cannot restart; a later retry is a new run
attempt that reads the current trusted report. A v5 report contains only
published, not an in-progress or uncertain checkpoint.

The publisher derives admission mechanically. Admissible means consumers may
accept the completed review result, not that the pull request has merge
approval. A final write is permitted only for a sealed execution outcome of
complete, complete coverage, valid findings, all findings represented in the
bounded summary, and passing live publication guards. All other combinations
are blocked.

| Execution and publication state | Permitted action | Checkpoint | Admission |
| --- | --- | --- | --- |
| Execution pending or incomplete, findings invalid, or summary over budget | Report failure in the Action; no v5 comment write | Preserve | blocked |
| Sealed complete and valid; publication not-started; live guards pass | One final summary create or update | Advance only when confirmed | blocked until confirmed |
| Exact final write or readback confirmed | Accept published report | New checkpoint in that report | admissible |
| Publication uncertain, failed, cancelled, or stale | No further write by that attempt | Read live report on next run | blocked |

The final body carries published and admissible as the postcondition of its
successful guarded write. Constructing that body is not proof of publication.
The single final comment mutation is the only authority transition. If the
response is uncertain, the next run classifies the actual trusted comment;
it never infers success from a local intent.

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
- `RetainedFinding` values under requirement-retained-finding;
- review limitations;
- the strict joined `RunStatus`;
- the required final sealed `ManifestReference`, including artifact identity
  and SHA-256 digest;
- the latest `PublicationOperation`;
- consumed review source identities and the published cost fields from the
  [cost projection](./2026-09-14-github-native-review-publication.md#requirement-cost-projection).

The planned incremental state contract is version 5.
Its strict envelope and marker must agree on `schemaVersion: 5`.
It must contain the scope checkpoint, generation-
qualified finding IDs, typed comparison outcomes, publication status, and
manifest reference defined by the linked specifications. Current v4 is the
command-free implementation with numeric finding IDs. V1 through v4 become
legacy input when v5 is delivered. None is an incremental checkpoint.

A v5 reference must match the report's repository, pull request, reviewed
revision, run, and scope identity. Missing or malformed manifest references or
digests classify the report as `invalid-current` and fail closed. They never
select legacy replacement or an automatic baseline. Artifact expiry does not
erase a structurally valid reference or reset the published Git checkpoint.
A later run records that old audit evidence is unavailable and performs fresh
work.

### requirement-run-status-and-metrics

The current v4 implementation prepends an owning-run in-progress notice.
It removes that notice after publication or terminal failure. The planned v5
path performs no progress write or cleanup; Action job status is its progress
signal. A v4 notice is never a v5 checkpoint.

The remaining visible-ledger requirements in this section apply to v4 only.
The planned v5 state uses the
[published cost projection](./2026-09-14-github-native-review-publication.md#requirement-cost-projection)
and places detailed metrics in the manifest. It writes no visible JSON ledger.

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

### requirement-retained-finding

This specification owns the strict `RetainedFinding` model. The manifest and
report reuse the same owning Zod schema. Neither defines another finding shape.
All strings use UTF-8 byte limits. Unknown fields fail validation.

```text
RetainedFinding = {
  schemaVersion: 1
  id: generation-qualified finding ID, at most 128 bytes
  identity: {
    schemaVersion: "review.finding-identity/v1"
    defectKind: trusted nonempty string, at most 64 bytes
    anchorKind: "changed-text" | "changed-tree-entry"
    causeDigest: lowercase SHA-256
  }
  identityKey: lowercase SHA-256
  occurrenceKey: lowercase SHA-256
  severity: "critical" | "required" | "optional" | "nit"
  status: "new" | "open" | "addressed" | "resolved" | "reopened"
  comparisonOutcome: "new" | "persisting" | "resolved" | "not_reviewed"
  axis: nonempty string, at most 64 bytes
  summary: nonempty sanitized string, at most 2,000 bytes
  recommendation: nonempty sanitized string, at most 2,000 bytes
  file: validated relative path, at most 512 bytes
  firstObservedRevision: full Git commit SHA
  evidenceHeadRevision: full Git commit SHA
  evidenceRunId: trusted manifest run ID, at most 128 bytes
  evidence: FindingEvidence
  location: LocationStatus
  verification: null | {
    headRevision: full Git commit SHA
    outcome: "present" | "absent" | "uncertain"
    evidence: EvidenceExcerpt
  }
}
```

`FindingEvidence`, `LocationStatus`, and `EvidenceExcerpt` come from the
[canonical evidence model](./2026-09-14-review-run-manifest-and-provenance.md#requirement-finding-evidence).
The scope specification owns the identity algorithm and cause-admission gate.
The finalizer validates the identity inputs, digests, generation, file, evidence
origin, and location together. `file` must equal the primary evidence path.
Every new finding references a sealed item in the current manifest.
A carried finding preserves its original `evidenceRunId` and validated evidence,
even when its path is outside the current selected denominator.
It does not invent a current item or depend on downloading an expired artifact.

Only verification for the current head can establish `resolved` or `reopened`.
The verified head must equal `evidenceHeadRevision`.
`absent` permits resolution. `present` permits reopening a resolved finding.
Null, stale, or uncertain verification permits neither transition.
`not_reviewed` carries the lifecycle forward without claiming fresh discovery.
Each ID is unique. Canonical order uses parsed generation bytes, then numeric
finding index. Each state finding has exactly one visible representation with
that same ID, either a detail row or an explicit bounded omitted-findings entry.
The omitted entry states ID, severity, lifecycle, and comparison outcome.
It never replaces an active blocker's detail row or contributes a false clean
verdict. A renderer cannot create findings.
No aliases, dispositions, effective severity, or command decisions enter v5.

### requirement-state-versions

This specification owns the schema-evolution matrix:

| State revision | Fields and marker | Readers | Migration and replacement |
| --- | --- | --- | --- |
| v1-v3 | Earlier state, including disposition-bearing v3. | Legacy identity classification only. | Findings, IDs, checkpoint, and visible metrics do not enter v5. |
| v4 | Current command-free lifecycle, v4 marker, numeric finding IDs, and visible metrics ledger. | Current v4 reader; v5 classifies it as legacy. | A fresh v5 baseline replaces it after scope-capable delivery. |
| v5 | Planned hidden state with ScopeCheckpoint, RetainedFinding, RunStatus, ManifestReference, PublicationOperation, and published cost. | One strict v5 reader and marker. | Invalid v5 fails closed; it never selects legacy replacement. |

The marker, state, and compressed envelope must name the same version.
The v5 contract has one shape. It includes the hidden transport and cost fields
defined by the publication draft. It never writes the v4 visible ledger.

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
lifecycle status and comparison outcomes even when prose matches.

The finalizer must collapse duplicate temporary identifiers before it assigns
stable identifiers. Previously published identifiers remain stable only when
the prior state passes the current strict schema.

The incremental-review scope contract uses generation-qualified IDs for new
baseline reports. The numeric format above remains the version 4 contract.

### requirement-lifecycle

Each retained finding has one lifecycle status:

- `new`: the current review detected the finding for the first time;
- `open`: the current review detected an active prior finding;
- `addressed`: current-head evidence suggests a fix, but verification is incomplete;
- `resolved`: current-head verification found that the problem is absent;
- `reopened`: the current review detected a previously resolved finding.

A finding has one severity. The current finding and persisted state schemas
reject disposition and effective-severity fields. Finding identifiers are
case-insensitive.

Each retained finding also has a separate typed `comparisonOutcome` with one of
`new`, `persisting`, `resolved`, or `not_reviewed`. This field is stored in the
validated state and rendered in the human projection; it does not replace
lifecycle status or severity. `not_reviewed` is assigned when the
later run omits the finding's path from its reviewable scope and cannot change
the lifecycle or imply resolution. `resolved` and `reopened` require
current-head verification under `requirement-fixed-verification`.

### requirement-fixed-verification

A separate review task must inspect retained findings against the current
head. A comment claiming a fix does not change the finding or start a review.

For planned v5, each inspected finding receives the canonical
`RetainedFinding.verification` value under requirement-retained-finding.
The finalizer binds it to the inspected finding ID.
Only current-head `absent` evidence can establish resolution.
Missing, stale, or uncertain evidence cannot resolve an active finding.
An unselected path carries its prior lifecycle under the scope contract.

### requirement-human-projection

The human projection must show the verdict, active counts, reviewed revision,
and one findings table. It must show
plain Markdown sections for active Critical and Required findings. Each section
must show the finding ID, severity, area, location, explanation, and
resolution.

Severity and lifecycle labels must use the emoji vocabulary from the source
review template.

The projection can omit internal ratings and run evidence. It must show a
deterministic limitation notice when retained evidence or history is
incomplete.

The projection shows at most 20 detailed finding rows and 10 verification entries.
Each remaining retained finding has one bounded omitted-findings entry under
requirement-retained-finding. The state block retains the complete bounded set.
If active blockers exceed the detailed-row limit, publication fails.

The projection must neutralize model-controlled text before Markdown renders
it. Active Critical and Required findings must remain visible before inactive
history when the projection reaches its limit.

### requirement-bounds

The state and human projection must have explicit size and item limits. The
retention policy must keep active blockers before non-blocking or inactive
findings. The v5 state admits at most 40 retained findings, matching the
review-output bound. If older history cannot fit, it adds a visible truncation
limitation. It never silently drops an active blocker or publishes a clean
verdict from incomplete retained state. If active blockers alone exceed the
bound, publication fails and preserves the previous checkpoint. The human
projection follows requirement-human-projection while state retains the
complete bounded set.

The publisher must reject an oversized final comment. State decompression
must stop at the configured output limit.

The workflow must pass bounded review input through a file. It must not place
the complete comment history in one command-line argument.

### requirement-review-boundary

The final note must state that the review agents did not execute pull-request
code, tests, builds, scripts, or checks. The note must not claim that the
workflow performed no Git operations.

### requirement-workflow-admission-and-concurrency

One review job must admit non-closed `pull_request_target` events only for
non-draft pull requests whose head repository is the current repository. A
read-only, dispatch-only job must verify that a manual request names a live,
open, non-draft pull request in the current repository before the review job
enters its cancellable concurrency group. Invalid dispatches must not enter
that group or cancel active reviews.
The workflow must not subscribe to `issue_comment` events.

The review job uses the `seqlane-code-review-<pull-request>` concurrency group
with `cancel-in-progress: true`. A closed `pull_request_target` event runs a
separate no-op cancellation job in the same group so it interrupts active
review work without starting review or publisher steps.

The v5 final publisher uses the separate non-cancelling group defined by
requirement-serialized-publication.

## Detailed design or contracts

The planned v5 publisher uses the single canonical
[hidden transport](./2026-09-14-github-native-review-publication.md#requirement-hidden-transport).
It does not put state in a code fence or collapsed details element.
The following transport and visible ledger describe the current v4 path only.

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
The state schema rejects embedded `run`, `runs`, and `runSummary` fields.

Run timestamps and identifiers are audit data. They do not decide publication
order across revisions. The live pull-request head and full Git revisions
decide eligibility. For the same reviewed revision, the GitHub run ID and
attempt prevent an older run from replacing a newer publication. Admitted review computation jobs cancel older computation for one pull
request; the v5 final publisher separately revalidates scope under its
non-cancelling queue. A closed pull-request event uses a separate no-op job in that same
group to interrupt active review work without starting review steps.
Current v4 progress-marker cleanup is scoped to the owning run. The v5 path
does not create a progress marker. Irrelevant comments do not enter either
review computation or publication.

The human status and severity labels are deterministic projections of the
validated state. Model output cannot select the final verdict or active
counts.

## Failure and edge cases

- Ignore state from an untrusted comment author.
- Reject malformed current-v5 state without selecting legacy replacement.
- For current v4, treat a missing, malformed, oversized, or unsupported run metrics ledger as
  an empty ledger without discarding valid review state.
- For current v4, reject publication that would make the visible run metrics ledger exceed
  the final-comment byte limit.
- Do not publish when the live pull request is closed, draft, or ineligible.
- Do not publish when the live head differs from the report head.
- Do not show a predecessor or delta when Git ancestry is not comparable.
- Keep a retained finding active when verification is absent or uncertain.
- Keep all retained blocking findings before lower-priority history.
- Do not start or cancel reviews from issue comments.

## Migration

The reader accepts only the current strict version 4 state shape. It does not
import v1 or v2 snapshots, disposition-bearing v3 state, or embedded run history.
If the existing trusted report has unsupported state, the next review starts
a new finding baseline in that same bot comment. Valid run metrics remain
independent of finding state.

The first scope-capable publication writes a unified v5 state and a fresh
baseline. It classifies older v1 through v4 reports only to replace them; it
does not migrate old findings, IDs, metrics, or checkpoints.

## Verification

- Add strict-schema, compatibility, and malformed-state tests.
- Reject v5 state without a valid manifest reference and digest; distinguish
  that failure from artifact expiry with a valid published checkpoint.
- Test every run-status gate, including valid request-changes results,
  incomplete coverage, uncertain final writes, and failed publication.
- Test two baseline publishers and two updates in the same shared queue.
  Exactly one trusted summary may be created; stale work preserves the prior
  checkpoint and retained findings.
- Test an ambiguous final response followed by exact and mismatched readback.
  No second write occurs while the first effect is unknown; a later run uses
  the live trusted state. Sealed manifest bytes remain unchanged.
- Test queue overflow and cancellation semantics, including coexistence with
  the separate review computation group, recovery, and duplicate dispatches.
- Test cancellation during a POST or PATCH followed by another baseline or
  update. Block the later write until the earlier effect is proved.
- Test explicit job permissions, default-branch workflow provenance, and model
  worker isolation from GitHub and artifact runtime credentials.
- Add lifecycle transition and stable-identifier tests.
- Test the single RetainedFinding schema in state and manifest, carried evidence
  outside the current denominator, unique ordering, and one visible entry per ID.
- Add current-head finding-verification tests.
- Add trusted-author and stale-head publication tests.
- Add workflow event and concurrency regression tests.
- Test current-v4 ledger parsing, malformed ledgers, duplicate runs, and derived cost.
- Test planned v5's single hidden transport and published cost projection.
  Reject visible-ledger fields, duplicate model definitions, and broken owner links.
- Execute the exact publisher script with bounded representative state.
- Run the branch workflow against an open pull request.

## Acceptance criteria

- The comment contains a concise human projection and one bounded state block.
- The next review restores validated state from the trusted bot comment.
- Stable finding identifiers survive open, resolved, and reopened transitions.
- A comment cannot resolve, dismiss, or downgrade a finding.
- Unsupported earlier finding state does not enter the next review.
- An old or untrusted run cannot replace the authoritative comment.
- Mandatory limitation notices remain visible after output bounds apply.
- Current v4 keeps its strict visible metrics ledger. Planned v5 uses one hidden
  state and cost projection. Neither creates per-run audit comments.
- In current v4, an invalid ledger starts fresh without changing valid review state.
- Planned v5 uses the canonical retained-finding, evidence, reference, and
  operation models. Unknown earlier writes block later publication and safe replay.
- Eligible pull-request updates and manual dispatches remain serialized per
  pull request. Comments do not trigger review.

## Traceability

- Source proposal: [Seqlane review template](https://github.com/marcolink/seqlane/issues/45)
- Review scope: [spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Execution evidence: [spec.review-run-manifest-and-provenance](./2026-09-14-review-run-manifest-and-provenance.md)
- Planned transport and recovery storage: [spec.github-native-review-publication](./2026-09-14-github-native-review-publication.md)
- Publication queue: [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency); [GitHub REST conditional-request limits](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- Delivery: [task.publish-versioned-pull-request-review-comments](../tasks/2026-09-05-publish-versioned-pull-request-review-comments.md)
- Delivery: [task.prevent-comment-triggered-review-cancellation](../tasks/2026-09-05-prevent-comment-triggered-review-cancellation.md)
- Delivery: [task.consolidate-pull-request-review-run-metrics](../tasks/2026-09-06-consolidate-pull-request-review-run-metrics.md)
- Simplification: [task.simplify-pull-request-review-triggers](../tasks/2026-09-24-simplify-pull-request-review-triggers.md)
- Architecture: [adr.review-publication-without-comment-commands](../adrs/2026-09-24-review-publication-without-comment-commands.md)
