---
id: spec.github-native-review-publication
title: GitHub-Native Review Publication and Storage
status: draft
owners:
  - core
created: 2026-09-14
updated: 2026-09-24
upstream:
  - adr.review-publication-without-comment-commands
  - spec.versioned-pull-request-review-comments
  - spec.incremental-pull-request-review-scope
supersedes: []
---

# GitHub-Native Review Publication and Storage

## Summary

The trusted bot comment is the review checkpoint. One hidden, versioned JSON
state drives the visible Markdown report. One bounded Actions artifact holds
structured evidence for each published review. The publisher writes the final
comment once, through the shared per-PR queue.

This draft proposes changes to the storage and projection parts of
[spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md).
It follows the superseding publication ADR, which removes the mechanical
disposition writer.
The existing active specification remains the current contract. PR #112 must
reconcile that specification and its incremental-scope and manifest
specifications with this draft before the new publication path can become
active. The manifest specification must land with
a stable identity and complete item, path, finding, and string limits. This
draft alone does not authorize a second active transport or state schema.

## Goals

- Keep the latest published checkpoint available without an external store.
- Keep detailed evidence out of the limited comment body.
- Show overall known published cost and last published run cost without a
  visible per-run JSON ledger.
- Warn before the comment reaches its size limits.
- Preserve published state across concurrent review events.

## Non-goals

- Store raw prompts, model transcripts, credentials, complete patches, or
  unbounded provider output.
- Use DynamoDB, a Git ref, or another coordination store.
- Require cross-run resume reuse in the first delivery.
- Keep failed or cancelled review evidence for audit.

## Terminology

- **Authoritative comment:** The one trusted bot summary comment for the PR.
- **Hidden state:** Validated JSON inside a base64-encoded HTML comment block.
- **Projection:** Visible Markdown rendered only from hidden state.
- **Published artifact:** A verified run artifact referenced by a confirmed
  final comment.
- **Cost period:** Published runs since the first report of the current state
  version; legacy visible ledger costs are excluded.

## Requirements

### requirement-comment-authority

The publisher uses the `ReviewAuthorityIndex` under
`requirement-comment-index` to locate and validate the authoritative comment.
Bounded reconciliation establishes whether zero, one, or multiple comments
from the configured bot contain the authoritative marker. Zero matches permit
initial creation only. Exactly one match permits an update. Two or more
matches fail closed with their comment IDs; no checkpoint is selected or
written until the ambiguity is reconciled outside publication. Within the
selected comment, the publisher accepts exactly one metadata marker and one
hidden state block. If index validation or bounded reconciliation cannot prove
uniqueness, publication fails closed.
The marker, decoded state, PR number, and full reviewed revision must agree.
An invalid current-version state fails closed; it must not become a fresh
baseline. The state is the sole source for the checkpoint, retained findings,
lifecycle, cost, and artifact references. Visible
Markdown and old metrics ledgers are never parsed as independent authority.

The new scope-capable state version starts a fresh baseline and cost period.
It does not migrate v1-v4 findings, IDs, checkpoints, or visible metrics
ledger entries. A new version must label the start of its cost period.
The version number and schema must have one meaning across review publishers.

The strict `EmptyReviewState` has `stateRevision: 0`, no checkpoint, no
findings, no artifact references, no consumed source identities, and no
accumulated cost. Initial creation reads this state and
writes revision 1. A single valid legacy bot comment can be replaced from the
same empty baseline when the migration rules authorize the new state version;
legacy data is not copied. A malformed current-version comment is not legacy
and still blocks publication. Creation, legacy replacement, operation digest,
and readback all use revision 0 as the predecessor.

### requirement-hidden-transport

The publisher serializes the validated state as canonical compact UTF-8 JSON,
compresses it with deterministic gzip, and base64-encodes the compressed bytes.
It wraps the encoded string in one HTML comment block after the visible
projection. The block is not placed in a Markdown code fence or collapsed
`<details>` element. The transport records the schema version and binds it to
the existing metadata marker. The decoder limits encoded input, compressed
bytes, and decompressed bytes before parsing and validates the strict schema.
Malformed base64, gzip, JSON, duplicated markers, or mismatched identity
cannot produce a checkpoint.

The base64 payload is at most 20,000 characters and must decode canonically
to at most 15,000 compressed bytes. The decoded UTF-8 JSON is at most 512,000
bytes. After validating the encoded length and alphabet, the decoder feeds
the compressed bytes to a streaming gzip decoder. It counts emitted bytes,
aborts as soon as the 512,000-byte limit would be exceeded, and only then
decodes UTF-8 with fatal error handling and parses JSON. It never calls an
unbounded whole-buffer decompressor. These limits apply to every readback and
reconciliation path.

The publisher renders visible text only from the same state it writes. No separate per-run JSON metrics block appears in the comment.
Bounded detailed metrics belong in the run artifact.

The trusted renderer treats model output, PR text, paths, provenance, and
artifact evidence as untrusted. It redacts known credentials and secret-like
values before either sink. It escapes Markdown and HTML metacharacters in
every untrusted projection field; no untrusted string becomes raw HTML or a
Markdown link. Links are constructed only from validated GitHub identities
or an explicitly allowlisted HTTPS URL. Reject `javascript:`, `data:`,
`file:`, protocol-relative, and malformed URLs. Artifact JSON uses a strict
field allowlist and bounded strings; URL-typed fields follow the same policy.

### requirement-cost-projection

The state stores a cost-period start, known cumulative USD cost as a decimal
string, published-run count, completeness, the last published run identity,
and its known cost or an explicit missing-cost value. Only confirmed published
reviews contribute. Missing provider cost never becomes zero. If any
published run lacks cost, show the known cumulative value with an
**incomplete** label. Show the last published run's known cost, or **unknown**.
Failed, stale, uncertain, and cancelled runs do not change these values.

The publisher derives each run's cost from validated execution events; a model
does not calculate it. It adds a GitHub run ID and attempt at most once. The
state retains a high-water pair for published review attempts, so an older or
duplicate attempt cannot add cost after bounded recent history is compacted.
The aggregate carries older known costs and incompleteness forward. The projection
does not render task-by-task JSON or a per-run ledger.

### requirement-size-warning

The encoded state payload is limited to 20,000 characters. The entire GitHub
comment, including its hidden block, is limited to 60,000 UTF-8 bytes. The
publisher measures the candidate after rendering, including a reserved
warning. At or above 80% of either limit, it shows a visible warning with
the current and maximum values for both measures. Any compaction or omitted
human detail also appears as a visible limitation. Active blocking findings
take priority over inactive history.

At a hard limit, the publisher does not write the candidate. It fails the
Action with the measured limit and keeps the previous checkpoint. A large
single-run increase can reach the hard limit before a prior warning was
visible; the Action failure is the required signal in that case. It must not
silently drop retained findings, cost, or evidence references to fit.

### requirement-comment-index

A `ReviewAuthorityIndex` is a typed, non-authoritative lookup artifact for one
repository and PR. It records the candidate authoritative comment ID, body
digest, state version and revision, last fully scanned comment boundary,
scan-completeness state, generation, predecessor index artifact ID, writer
run identity, and index digest. The comment remains the checkpoint. An index
can only select a comment for direct validation; it cannot repair or replace
comment state.

The normal publisher lists one API page by the exact repository-and-PR index
name, reads at most 1 MiB, and spends at most 10 seconds on index lookup. It
accepts one verified newest generation whose predecessor chain and trusted
default-branch workflow provenance are valid. It then reads the indexed
comment by ID and scans comments created or updated after the saved boundary.
If the index is missing, ambiguous, stale, or incomplete, the publisher makes
no comment write and dispatches bounded reconciliation.

Reconciliation reads at most ten comment pages, 10 MiB of response bodies,
1,000 comments, or 30 seconds per invocation. It persists the next cursor and
overlapping boundary in a new index generation. It reports the scanned range
and incomplete coverage. Only a complete scan with zero or one matching bot
comment can publish a usable index. Two or more matches record their IDs and
block publication until a separately authorized repair removes the ambiguity.
No publisher deletes or chooses between duplicate comments.

### requirement-artifact-admission

A strict repository `ReviewStoreIndex` is non-authoritative control state. It
tracks outstanding candidate reservations and artifacts, their producer and
source identities, stored bytes, per-PR totals, admission timestamps, and the
recovery scan cursor. A repository-wide admission mutex serializes configured
index writers. A canceled or overflowed admission job fails before reservation
or upload and needs no replay. Each immutable index generation names and
hashes its predecessor. The updater verifies the newest generation, writes
and verifies its replacement, then deletes superseded generations. Missing or
ambiguous index state triggers bounded reconstruction and blocks new uploads
until inventory is complete.

Before candidate upload, admission reserves the artifact's 32 MiB compressed
maximum. After verified upload, it replaces that reservation with the actual
GitHub artifact size. Publication or proven cleanup removes the outstanding
entry. Admission rejects a candidate before upload when any hard limit would
be exceeded:

- 20 outstanding candidates or 256 MiB of outstanding stored bytes for one PR;
- 200 outstanding candidates or 1 GiB of outstanding stored bytes repository-wide;
- 10 candidate admissions per PR or 200 repository-wide in a rolling hour;
- two live generations per control-index name, 64 KiB decoded per index, or
  64 MiB total stored control artifacts.

Reservations count toward candidate and byte limits until reconciled. Review
candidates, authority indexes, and store indexes have distinct names and
strict schemas. The recovery cursor is part of the store index. Control
artifacts never carry checkpoint state or review evidence. A rejected
admission fails the Action with current counts and bytes, the limiting value,
and recovery guidance. It preserves the comment checkpoint and does not claim
a published review. The separate
256 MiB per-PR and 1 GiB repository thresholds for retained **published**
evidence remain advisory because those artifacts cannot be deleted merely to
admit a new review.

### requirement-published-artifact

Before publisher dispatch, the unqueued producer seals a strict manifest and
bounded structured evidence for the run. It uploads one immutable Actions artifact
with 90-day retention, then verifies artifact ID, repository, trusted
workflow, GitHub run ID and attempt, schema, canonical uncompressed digest,
and size. The final comment stores that verified reference. The artifact may
contain item outcomes, provenance, finding evidence, and detailed usage and
cost metrics. It excludes secrets, prompts, complete patches, and unbounded
logs. The first delivery uses one final review-evidence artifact and no review
artifact journal or append sequence. The bounded authority-index and
store-index artifacts are operational metadata and never carry review
evidence or checkpoint state.

The run artifact has a hard 2 MiB uncompressed manifest limit, 512 KiB
compressed manifest limit, 32 MiB compressed total limit, and 64 MiB total
uncompressed limit. Retrieval streams each archive entry through per-entry
and cumulative byte budgets before parsing or hashing. It rejects duplicate
entries, traversal paths, symlinks, and excess entries. Item, path, finding,
and string limits must be defined by the canonical manifest specification
before this draft becomes active. Retained published evidence has advisory
usage thresholds of 256 MiB per PR and 1 GiB repository-wide over 90 days.
A warning based on incomplete inventory must say so. Upload, integrity,
retention-setting, or hard-size failure blocks
final publication and preserves the old checkpoint.

A new run reads the comment first. It fetches a specific artifact by the
stored ID only when needed for an audit or future reuse decision. It never
loads all previous artifacts to find the checkpoint. If the artifact expired
or fails verification, preserve the valid comment checkpoint and retained
findings, report missing audit detail, and recheck affected work. The first
delivery need not implement cross-run resume; no run may claim reused work
without verified source evidence.

### requirement-final-publication

The new review path makes one final authoritative-comment mutation. Job and
step status show progress. It creates no progress notice or inline finding
comment. The existing v4 progress path remains legacy until replacement.
Review computation may be cancelled when a newer revision arrives. Final review publication uses a non-cancelling per-PR Actions queue. Every publisher uses the exact case-normalized key
`seqlane-review-publication-<repository-id>-<pr-number>`. It uses `queue: max`
without `cancel-in-progress: true`.
GitHub allows up to 100 pending jobs in that group; overflow is cancelled and
must be visible. Queue admission alone is not durable delivery. A cancelled
pending publisher is recovered from its sealed GitHub Actions candidate
artifact. The default-branch recovery dispatcher handles producer and
publisher `workflow_run: completed` events and sweeps terminal
runs and candidate artifacts on a schedule. It re-dispatches a trusted
publisher only after proving the earlier attempt did not send a comment
write. The replay retains the original review run ID and attempt, but uses
its own writer run ID. It checks the current head and state; a superseded
review becomes stale. Duplicate recovery
events can dispatch duplicate attempts, but the shared queue and source
identity check make them idempotent. A cancelled replay is eligible for the
same recovery. Recovery failure remains visible and retains a review
candidate until safe replay, cleanup, or expiry; it cannot claim publication.

The review producer is outside the publication queue. After successful model
work, it seals, uploads, and verifies the candidate artifact, then dispatches
the publisher with its artifact ID, source run ID and attempt, PR number,
scope identity digest, and manifest digest. The producer never writes the
authoritative comment. The queued publisher only consumes and revalidates
that existing candidate; it never creates a second review artifact. A
producer cancellation before verified upload has no recoverable publication.
A cancellation after upload is recoverable from the candidate even if the
initial dispatch was never sent. The hidden state records consumed source
identities, so a replay or duplicate dispatch becomes a no-op after publication.

A queued publisher re-reads the live PR and trusted comment. It validates
the captured scope, report identity, checkpoint, head, base, and target. A
stale attempt makes no write.

The hidden state stores one typed `PublicationOperation`:

```text
PublicationOperation = {
  schemaVersion: 1,
  writerKind: "full-review",
  pullRequestNumber: positive integer,
  stateRevision: positive integer,
  writerRunId: decimal GitHub workflow run ID,
  writerAttempt: positive integer,
  source: { kind: "review", sourceRunId: decimal GitHub run ID,
            sourceAttempt: positive integer, scopeIdentityDigest: SHA-256 },
  payloadDigest: lowercase SHA-256
}
```

The store index also records one typed review publication link:

```text
ReviewPublicationLink = {
  schemaVersion: 1,
  repositoryId: decimal GitHub repository ID,
  pullRequestNumber: positive integer,
  sourceIdentityDigest: lowercase SHA-256,
  producer: {
    workflowId: decimal GitHub workflow ID,
    runId: decimal GitHub run ID,
    attempt: positive integer
  },
  candidate: {
    artifactId: decimal GitHub artifact ID,
    artifactName: bounded canonical name,
    manifestDigest: lowercase SHA-256
  },
  publisher: null | {
    workflowId: decimal GitHub workflow ID,
    runId: decimal GitHub run ID,
    attempt: positive integer,
    registrationArtifactId: decimal GitHub artifact ID
  }
}
```

The producer writes the link with `publisher: null` when candidate upload is
verified. If dispatch is never sent, recovery can enumerate that durable
entry and inspect the candidate through `producer.runId` and
`candidate.artifactId`. A publisher registration job runs before its writer
job enters the per-PR mutex. It verifies the producer-owned candidate, uploads
a bounded registration artifact in the publisher run, and writes a verified
replacement store-index generation with the publisher workflow run and
registration artifact IDs under the repository admission mutex. The queued
writer accepts only that registered link. A replay retains the source,
producer, and candidate fields and replaces only the publisher registration
after proving that no prior write can still complete.

`stateRevision` is exactly one greater than the freshly read trusted state,
including `EmptyReviewState` revision 0.
The writer identity and source are validated, never supplied by model output.
To calculate `payloadDigest`, render the deterministic complete comment with
only that digest field omitted from the state. Hash those UTF-8 bytes. Then
set the digest, rerender, and send the final body. On readback, parse the
hidden state, verify the typed operation, rerender with only the digest field
omitted, and compare the hash. An uncertain current attempt counts as
published only when the live bot comment's ID, complete body bytes, operation
identity, and artifact reference exactly match its submitted candidate.

The single confirmed final comment write is the checkpoint commit point.
GitHub comment POST and PATCH are not
compare-and-swap operations; this guarantee covers configured writers using
the shared queue. A writer outside the queue violates the contract.

Upload and verify the artifact before the final comment write. If the write
result is ambiguous, read the trusted comment and accept only an exact
operation identity and body match. Do not send another write while the first
may complete. A known failed write leaves the old checkpoint authoritative.
Delete a candidate artifact only after proving it was not published. The
candidate name includes the trusted PR number, producer run ID, and attempt.
Recovery resolves the producer run and exact artifact ID from the verified
`ReviewPublicationLink`; it never searches the publisher run for review
evidence.
The `workflow_run: completed` event triggers an independent Action-owned
reconciler from the default branch. Before listing, replaying, or deleting,
it fetches the event run and linked producer or publisher jobs as applicable
through the GitHub API. It requires the run and artifact to belong to the
current repository; an allowlisted workflow ID and file path whose definition
commit is reachable from the trusted default branch; matching run ID, attempt,
PR number, artifact name, and artifact owner; an event of
`pull_request_target` or `workflow_dispatch`; and the
allowlisted publisher job belonging to that run. It compares the event hint
with the fetched run before trusting either.
For `pull_request_target`, it rechecks the live PR and excludes fork-origin
reviews. A
`workflow_dispatch` run is eligible only from the trusted default-branch
definition; PR-branch dispatches are excluded. A replay dispatch also has to
match its validated original source identity. Event payloads and artifacts
are untrusted hints.
The reconciler never executes PR-controlled code or artifact content, and
validates artifact bytes before use. Its inspection job has only Actions and
PR/issue read access. Only a separate recovery job receives `actions: write`
for dispatch or deletion. Neither job receives comment-write permission.

The scheduled sweep has fixed limits of ten API pages, 1,000 examined runs,
and five minutes per invocation. Its strict cursor is part of the
`ReviewStoreIndex` and records the repository ID, allowlisted workflow IDs,
current 90-day time window, next API page or time shard, and last completed
boundary. Each sweep loads the newest valid store-index generation produced
by the allowlisted recovery workflow, scans with overlap at the saved
boundary, and writes the next immutable generation before deleting older
confirmed generations.
If a time shard exceeds the page budget, it bisects that shard and records
both remaining halves instead of skipping results. A missing, expired, or
invalid cursor restarts a bounded 90-day scan and reports reduced coverage.
The workflow-run trigger remains the primary recovery path. The sweep reports
its examined range, remaining range, rate-limit state, and whether coverage
is complete; reaching a budget is continuation, not success or deletion.

The reconciler lists artifacts only for the verified producer or publisher
run named by the link and checks publisher-job status, candidate artifact ID,
registration artifact ID, source identity, and the live trusted comment.
If the publisher never started, no comment write could have occurred. It
replays an eligible current source rather than deleting its review candidate.
An already published source keeps its artifact for 90 days, even if a newer
comment replaces its reference. If the source is stale and provably never
published, the reconciler deletes the candidate only after proving that no
write remains in flight.
For a started publisher, it accepts an exact operation and artifact-reference
match as published. It deletes only after a definite pre-write failure or
other proof that the write was not sent. A missing reference alone is not
proof when a write may have been in flight or a later report may have
replaced it. Such candidates remain until a later safe reconciliation or
normal 90-day expiry, with an Action notice. The reconciler never mutates the
comment or advances a checkpoint; only a replay publisher may do that. A
confirmed published artifact remains for 90 days. Failed and cancelled
reviews have no published artifact. An
unresolved effect fails closed and is visible in the Action result.

## Detailed design or contracts

```text
visible Markdown projection
<!-- seqlane-review-state:v5
<base64 of deterministic gzip of canonical JSON>
-->
```

The unqueued producer validates the sealed run, uploads and verifies its
candidate artifact, and dispatches the separate publisher. The publisher
enters the shared queue, verifies the existing candidate, reads the live PR,
uses the authority index and bounded reconciliation to prove comment
uniqueness, reconciles authorized decisions, merges the run into the current
state, renders the projection and hidden state, checks sizes, writes the final
comment, and reconciles the result. A replay publisher verifies the same
candidate instead of uploading another artifact. The comment reference makes
it published.

## Failure and edge cases

- An invalid current state blocks publication; an expired artifact does not
  reset a valid checkpoint.
- Multiple authoritative bot comments block creation and update; publication
  never guesses which duplicate owns the checkpoint.
- A stale head, target, base, scope, or report identity makes no comment
  write and leaves a candidate artifact unpublished for cleanup.
- An uncertain write is resolved by exact readback. Absence during an
  in-flight request alone is not proof that the request failed.
- A queue overflow or platform cancellation starts replay only when its
  comment write was provably never sent. If that cannot be proved, keep the
  candidate and report an unresolved effect instead of risking a second write.
- A size breach fails visibly. No compaction changes the cost total or hides
  active blocking findings.

## Migration

PR #112's v5 proposal must include this hidden transport and cost shape when
it first writes v5. Earlier v1-v4 content is classified but not migrated into
the new checkpoint. Old visible metrics ledgers are ignored for new cost
totals. If v5 was already written without this shape, introduce a distinct
new state version rather than treating two schemas as v5.

## Verification

- Round-trip hidden state, malformed transport, strict identity, and
  bounded decompression tests at 512,000 and 512,001 decoded bytes, including
  a high-expansion gzip payload and malformed UTF-8.
- Deterministic projection and cost tests: missing provider cost,
  duplicate attempt, compacted history, and new cost-period label.
- Render at 79%, 80%, and hard limits with multibyte text; show warning
  and preserve old checkpoint on rejection.
- Verify one sealed artifact, 90-day retention, direct-ID retrieval,
  expiry, integrity failure, hard per-run bounds, and advisory warnings.
- Test upload-before-comment ordering, exact readback, definite and
  uncertain failures, producer cancellation before and after upload, and
  cleanup of a proven unpublished artifact.
- Test review writers in one queue, stale updates, queue overflow,
  cancelled replay, duplicate recovery dispatch, and one final write.
- Reject wrong-repository, fork, PR-branch workflow dispatch, untrusted
  workflow file/ref, mismatched run and artifact, and ambiguous in-flight
  writes before recovery mutation.
- Verify zero, one, and multiple authoritative comment matches. Exercise
  recovery cursor pagination, time and page budgets, boundary overlap,
  overfull-shard bisection, restart after expiry, and incomplete coverage.
- Run `pnpm run test:mapping`, focused Action tests, documentation validation,
  and a hosted baseline and follow-up workflow.

## Acceptance criteria

- One trusted comment restores the full published checkpoint from a hidden
  bounded state block and renders one concise projection.
- The visible report shows known overall and last-run cost, with an
  incomplete label when data is missing, and no per-run JSON ledger.
- At 80% of either limit, users see exact size and cap values; at a hard
  limit, the prior checkpoint remains and the Action fails clearly.
- Each confirmed published review references one verified, 90-day run
  artifact. Failed and cancelled runs add no published artifact.
- Review publishers share one queue and cannot overwrite newer state with
  an old checkpoint.

## Delivery state

This is a draft future contract, not an amendment to the current active
review-comment specification. Implementation is pending. It cannot become
active until PR #112 lands a canonical manifest specification with stable ID
and complete bounds, updates the existing review-comment contract, and aligns
the single v5 schema. No delivery is claimed here.

## Traceability

- Architecture: [adr.review-publication-without-comment-commands](../adrs/2026-09-24-review-publication-without-comment-commands.md)
- Finding lifecycle: [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- Incremental scope: [spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Proposed scope and manifest: [PR #112](https://github.com/marcolink/seqlane/pull/112)
- Queue semantics: [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- Recovery trigger: [GitHub `workflow_run` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- Artifact lookup and deletion: [GitHub Actions artifacts API](https://docs.github.com/en/rest/actions/artifacts)
