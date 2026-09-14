---
id: spec.github-native-review-publication
title: GitHub-Native Review Publication and Storage
status: active
owners:
  - core
created: 2026-09-14
updated: 2026-09-14
upstream:
  - adr.github-native-review-publication-state
supersedes: []
---

# GitHub-Native Review Publication and Storage

## Summary

The trusted bot comment is the review checkpoint. One hidden, versioned JSON
state drives the visible Markdown report. One bounded Actions artifact holds
structured evidence for each published review. The publisher writes the final
comment once, through the shared per-PR queue.

This contract amends the storage and projection parts of
[spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md).
That specification still owns finding lifecycle. The proposed incremental
scope and manifest contracts in PR #112 must adopt this contract before they
are delivered. Their proposed checkpoint, item-outcome, and provenance rules
remain in force where they do not conflict with this storage contract.

## Goals

- Keep the latest published checkpoint available without an external store.
- Keep detailed evidence out of the limited comment body.
- Show overall known published cost and last published run cost without a
  visible per-run JSON ledger.
- Warn before the comment reaches its size limits.
- Preserve dispositions and published state across concurrent review events.

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

The publisher reads the live PR and locates the configured bot's authoritative
comment. It accepts exactly one metadata marker and one hidden state block.
The marker, decoded state, PR number, and full reviewed revision must agree.
An invalid current-version state fails closed; it must not become a fresh
baseline. The state is the sole source for the checkpoint, retained findings,
lifecycle, disposition projection, cost, and artifact references. Visible
Markdown and old metrics ledgers are never parsed as independent authority.

The new scope-capable state version starts a fresh baseline and cost period.
It does not migrate v1-v4 findings, dispositions, IDs, checkpoints, or visible
metrics ledger entries. A new version must label the start of its cost period.
The version number and schema must have one meaning across review and
mechanical-disposition publishers.

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

The publisher renders visible text only from the same state it writes. A
mechanical disposition changes that state and regenerates the entire
projection. No separate per-run JSON metrics block appears in the comment.
Bounded detailed metrics belong in the run artifact.

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
The aggregate carries older known costs and incompleteness forward. The
mechanical-disposition writer preserves cost data unchanged. The projection
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

### requirement-published-artifact

Before final publication, the Action seals a strict manifest and bounded
structured evidence for the run. It uploads one immutable Actions artifact
with 90-day retention, then verifies artifact ID, repository, trusted
workflow, GitHub run ID and attempt, schema, canonical uncompressed digest,
and size. The final comment stores that verified reference. The artifact may
contain item outcomes, provenance, finding evidence, and detailed usage and
cost metrics. It excludes secrets, prompts, complete patches, and unbounded
logs. The first delivery uses one final artifact and no artifact journal or
append sequence.

The run artifact has a hard 2 MiB uncompressed manifest limit, 512 KiB
compressed manifest limit, and 32 MiB compressed total limit. Item, path,
finding, and string limits are owned by the manifest specification in PR
#112. Per-PR 256 MiB and repository 1 GiB over 90 days are advisory usage
thresholds, not atomic reservations. A warning based on incomplete inventory
must say so. Upload, integrity, retention-setting, or hard-size failure blocks
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
comment. The existing v3 progress path remains legacy until replacement.
Review computation may be cancelled when a newer revision arrives. Final
review publication and mechanical dispositions use the **same** non-cancelling
per-PR Actions queue. It must use `queue: max`, with visible handling if the
platform cancels a pending job. A queued publisher re-reads the live PR,
trusted comment, and authorized command ledger. It validates the captured
scope, report identity, checkpoint, head, base, and target. It merges decisions
made during computation before rendering. A stale attempt makes no write.

Each final body includes a monotonic state revision, writer kind, source
identity, and payload digest. The single confirmed final comment write is
the checkpoint commit point. GitHub comment POST and PATCH are not
compare-and-swap operations; this guarantee covers configured writers using
the shared queue. A writer outside the queue violates the contract.

Upload and verify the artifact before the final comment write. If the write
result is ambiguous, read the trusted comment and accept only an exact
operation identity and body match. Do not send another write while the first
may complete. A known failed write leaves the old checkpoint authoritative.
Delete a candidate artifact only after proving the final comment did not
reference it. A confirmed published artifact remains for 90 days. A failed
or cancelled review has no published artifact. An interrupted runner can
leave a temporary orphan; recovery must reconcile the comment before cleanup.
An unresolved effect fails closed and is visible in the Action result.

## Detailed design or contracts

```text
visible Markdown projection
<!-- seqlane-review-state:v5
<base64 of deterministic gzip of canonical JSON>
-->
```

The final publisher performs these steps in order: validate sealed run,
upload and verify its artifact, enter the shared queue, read live PR and bot
comment, reconcile authorized decisions, merge the run into the current
state, render the projection and hidden state, check sizes, write the final
comment, and reconcile the result. An artifact uploaded before queue entry
is only a candidate. The comment reference makes it published.

## Failure and edge cases

- An invalid current state blocks publication; an expired artifact does not
  reset a valid checkpoint.
- A stale head, target, base, scope, or report identity makes no comment
  write and leaves a candidate artifact unpublished for cleanup.
- An uncertain write is resolved by exact readback. Absence during an
  in-flight request alone is not proof that the request failed.
- A queue overflow or platform cancellation cannot claim publication.
- If an authorized disposition arrives during model work, the final
  publisher incorporates it from the live command ledger.
- A size breach fails visibly. No compaction changes the cost total or hides
  active blocking findings.

## Migration

PR #112's v5 proposal must include this hidden transport and cost shape when
it first writes v5. Legacy v1-v4 content is classified but not migrated into
the new checkpoint. Old visible metrics ledgers are ignored for new cost
totals. If v5 was already written without this shape, introduce a distinct
new state version rather than treating two schemas as v5.

## Verification

- Round-trip hidden state, malformed transport, strict identity, and
  bounded decompression tests.
- Deterministic projection and cost tests: missing provider cost,
  duplicate attempt, compacted history, mechanical disposition, and new
  cost-period label.
- Render at 79%, 80%, and hard limits with multibyte text; show warning
  and preserve old checkpoint on rejection.
- Verify one sealed artifact, 90-day retention, direct-ID retrieval,
  expiry, integrity failure, hard per-run bounds, and advisory warnings.
- Test upload-before-comment ordering, exact readback, definite and
  uncertain failures, and cleanup of a proven unpublished artifact.
- Test full-review and disposition writers in one queue, decisions arriving
  during computation, stale updates, queue overflow, and one final write.
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
- Review and disposition publishers share one queue and cannot overwrite
  newer state with an old checkpoint or disposition set.

## Delivery state

This specification defines intended behavior. Implementation is pending.
PR #112 is a proposed consumer and must be reconciled with this contract.

## Traceability

- Architecture: [adr.github-native-review-publication-state](../adrs/2026-09-14-github-native-review-publication-state.md)
- Finding lifecycle: [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- Mechanical writers: [spec.mechanical-pull-request-review-dispositions](./2026-09-06-mechanical-pull-request-review-dispositions.md)
- Proposed scope and manifest: [PR #112](https://github.com/marcolink/seqlane/pull/112)
