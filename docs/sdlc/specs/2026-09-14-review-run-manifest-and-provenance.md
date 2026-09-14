---
id: spec.review-run-manifest-and-provenance
title: Review Run Manifest and Provenance
status: active
owners:
  - core
created: 2026-09-14
updated: 2026-09-14
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Review Run Manifest and Provenance

## Summary

This specification defines one machine-readable execution manifest per
admitted pull-request review. It records the frozen scope, configured review
lanes, explicit outcomes, finding evidence, provenance, and limitations.
The manifest is assembled in the trusted Action job and uploaded once, after
finalization, as one immutable GitHub Actions artifact. It is audit evidence,
not a cross-run checkpoint or an operational store.

The [incremental review scope specification](./2026-09-13-incremental-pull-request-review-scope.md)
owns path selection and checkpoint semantics. The
[versioned comment specification](./2026-09-05-versioned-pull-request-review-comments.md)
owns the trusted report and publication. No external database, lease service,
journal, or artifact compaction is required.

## Goals

- Freeze reviewed input and configured lanes before model work.
- Account for each selected item and every expected lane result.
- Preserve bounded evidence and provenance for a completed run.
- Make incomplete or invalid work visible and non-admissible.
- Bound artifact size before upload and preserve the prior checkpoint on failure.

## Non-goals

- Cross-run item reuse or resume in this revision.
- Storing complete patches, prompts, credentials, or provider logs.
- Repository-wide artifact quotas, compaction, or a separate publication journal.

## Terminology

- **Selected path set**: the sealed R supplied by the scope selector.
- **Manifest item**: one path, evidence form, and hunk unit assigned to a batch.
- **Expected lanes**: the frozen configured discovery lanes for a selected
  batch; empty when there is no discovery scope.
- **Provenance**: bounded input, rule, reviewer, and model identities.

## Requirements

### requirement-versioned-manifest

Every admitted run creates a strict review.run-manifest/v1 value before model
work. Its frozen input includes run ID, pull-request number, review mode,
target, base, head, checkpoint when applicable, exact ScopeIdentity, selected
paths and evidence digests, configured lanes, rule-set hash, reviewer version,
provider and model identity, and relevant runtime-configuration hashes.
No model output can change this input or the selected denominator.

The manifest stores execution statuses coverage and finding. The publisher
joins them with publication and derived admission under the
[run status contract](./2026-09-05-versioned-pull-request-review-comments.md#requirement-run-status-gates).
Empty collections use []; canonical ordering is mandatory for artifact bytes
and digest validation. Publication evidence belongs to the trusted report,
never to the sealed execution manifest.

### requirement-canonical-manifest-bytes

Canonical bytes are UTF-8 JSON with no byte-order mark or insignificant
whitespace. Object keys are sorted by unsigned UTF-8 byte order. Strings use
one JSON escape form: escape quotation mark, backslash, and control characters
as lowercase `\u00xx`; do not escape other Unicode scalar values. Reject
invalid UTF-8, unpaired surrogates, duplicate object keys, non-finite numbers,
and unknown fields. Counts and ordinals are integers; other numeric values use
canonical decimal strings. An absent optional field is omitted, not encoded as
`null`, unless its schema explicitly requires `null`. Git paths retain their
validated raw UTF-8 bytes; Unicode normalization must not merge distinct Git
paths. The digest is SHA-256 of these exact uncompressed bytes.

Arrays use these complete sort keys, in order. Byte comparisons are unsigned,
lexicographic, and prefix-shorter-first; integer comparisons are numeric.
`pr-patch` precedes `change-evidence` wherever an evidence-form rank is needed.
The adapter rejects duplicate identity keys; it never depends on insertion
order, locale collation, or worker completion order.

| Array | Canonical sort key |
| --- | --- |
| Selected and excluded paths | Raw relative-path UTF-8 bytes. |
| Manifest items | `batchOrdinal`, path bytes, evidence-form rank, numeric `hunkOrdinal`, item-ID bytes. |
| Item outcomes | Item-ID bytes; exactly one outcome per sealed item. |
| Expected lanes and lane results | Batch ordinal, then lane-ID bytes; each pair is unique. |
| Failure records | Run-level before item-level, then item-ID bytes (empty for run), failure-class bytes, numeric attempt, reason bytes. Exact duplicates are rejected. |
| Retry records | Item-ID bytes, numeric attempt, invocation-ID bytes. The tuple is unique. |
| Retained findings | Parsed generation bytes, numeric finding index; unallocated candidates are excluded from this array. |
| Limitations | Limitation-code bytes, related item-ID bytes (empty if absent), explanation bytes. Exact duplicates are coalesced with a numeric occurrence count. |

Failure records must contain their level, optional sealed item ID, failure
class, attempt, and bounded sanitized reason. Retry records must contain item
ID, attempt, and locally allocated invocation ID. Limitations must contain a
typed code, optional related item ID, bounded explanation, and positive
occurrence count. The same canonicalizer is used when sealing, reading, and
recomputing a digest. Permuting otherwise equal input records must produce
identical bytes and digests.

### requirement-manifest-items

The selector seals a typed denominator before dispatch. Each ManifestItem has
one validated relative path, batch ordinal, evidence form (pr-patch or
change-evidence), hunk ordinal, evidence digest, and deterministic item ID.
A zero-hunk path uses ordinal zero and retains tree-entry metadata so binary,
mode-only, or absent-path evidence is not mistaken for an empty patch. Hunk
ordinals begin at one within each complete path and evidence form and never
restart at a batch boundary. Each tuple is globally unique, belongs to one
batch, and matches the collector's complete evidence inventory. The union of
item paths equals the selected set R. Missing required evidence fails before
model work.

The manifest also seals the configured lane IDs for every batch. Each batch
has one result for each expected lane, with a bounded result reference,
digest, evidence references, retry count, and final attempt identity. Each
completed item refers to the validated lane results for its assigned batch.
No duplicate, unknown, missing, malformed, or failed lane result lets an item
in that batch count as completed. A retry consumes its normal model budget;
only the final successful attempt can satisfy the lane. Historical-finding
verification is recorded separately and must complete when retained findings
require it. For no-change scope, there are no discovery items or expected
discovery lanes; retained-finding verification still gates finding validity.

The strict batch-lane result contains batch ordinal, configured lane ID,
terminal attempt ID, retry count, result reference and SHA-256 digest, and
bounded evidence references. It rejects unknown fields. The result reference
resolves inside the same artifact and must cover the planned batch paths and
evidence form. No model-supplied lane ID can enlarge the expected set.

### requirement-terminal-outcomes

The trusted finalizer records exactly one terminal outcome for each sealed
item: completed, failed, or waived. A completed outcome references the
validated batch-lane results and item evidence above. A failed outcome records
a bounded sanitized reason and one failure class: provider, timeout, cancelled,
configuration, input, budget, panic, or unknown. A waived outcome requires a
deterministic reason and an authorizing policy ID and hash from the frozen
trusted rule set. Waived work is incomplete even when authorized. Model output
cannot mark work complete, authorize a waiver, or change an item ID.

```text
ItemOutcome = { itemId: sealed item ID } & (
  | { outcome: "completed";
      laneResultKeys: exact configured batch-lane keys;
      evidenceDigest: lowercase SHA-256 matching the item }
  | { outcome: "failed";
      failureClass: "provider" | "timeout" | "cancelled" |
        "configuration" | "input" | "budget" | "panic" | "unknown";
      origin: "execution" | "finalization";
      reason: nonempty sanitized string, at most 2,000 bytes }
  | { outcome: "waived";
      reason: nonempty sanitized string, at most 2,000 bytes;
      authorization: { policyId: trusted rule ID;
        ruleSetHash: lowercase SHA-256 } }
)
```

Finalization replaces a missing item outcome with failed/unknown and the
reason "No validated terminal outcome was recorded." It never replaces an
existing terminal outcome. Conflicting transitions fail validation; repeated
identical transitions are idempotent. Coverage is complete only when every
sealed item is completed with every expected lane result validated, all
expected batches are accounted for, and no required evidence is missing.
Failed and waived items make coverage incomplete and block final publication.
A lane or verification failure cannot be hidden behind a successful result
from another lane.

### requirement-finding-evidence

The manifest retains each admitted finding's typed FindingEvidence and
LocationStatus from the
[scope contract](./2026-09-13-incremental-pull-request-review-scope.md#requirement-new-finding-admission).
The finding references one sealed item and its evidence digest. The trusted
finalizer verifies its primary changed-line or changed-tree-entry anchor
against that frozen item: pr-patch for a baseline, change-evidence for an
incremental run. Full PR patch context from an earlier hunk cannot satisfy
an incremental cause anchor. The finalizer records a typed unlocated or
ambiguous status with a visible limitation when a safe line is unavailable.
A finding without valid evidence is invalid; a safe but unlocated finding
remains visible in the summary. The trusted comment persists the same bounded
finding fields so later runs do not depend on an expired artifact for finding
continuity.

### requirement-manifest-lifecycle

The selected denominator, lane set, immutable revisions, and rule identity
are sealed before model work. The trusted job accumulates validated outcomes
in memory. Finalization records missing outcomes as failed/unknown, derives
coverage and finding status, and then seals the manifest. No writer can append
to or revise a sealed manifest. Failure is recorded at the narrowest known
level; a failed item does not by itself determine the run-level outcome.

The execution outcome is complete, partial, failed, cancelled, or stale.
Complete requires complete coverage and valid findings. Stale and cancelled
take precedence when observed before sealing; otherwise incomplete execution
is partial if any item succeeded, or failed. Execution completion does not
mean the final GitHub comment was published.

### requirement-manifest-persistence

The Action-owned adapter serializes the sealed manifest once and uploads one
immutable GitHub Actions artifact for the trusted workflow run and attempt.
There is no initial artifact, append sequence, journal artifact, or cross-run
resume. The adapter validates schema, canonical bytes, artifact ID, repository,
workflow run and attempt, ScopeIdentity, and SHA-256 digest before passing a
ManifestReference to the final publisher. The publisher downloads that same
artifact and repeats these checks before it enters the publication queue;
an invalid artifact prevents publication. The reference contains those
identities plus manifest run ID, reviewed revision, schema version, artifact
ID, uncompressed byte count, and digest. It has no snapshot sequence.

The v5 trusted report stores the final ManifestReference and a bounded
manifest summary. A missing or malformed reference makes current state
invalid; it never triggers legacy baseline replacement. Artifact expiry later
does not erase an otherwise valid published Git checkpoint or retained
findings. The next run performs fresh bounded work and states that old audit
evidence is unavailable. A missing artifact cannot be treated as reusable
work or as proof of a previous run's coverage.

The artifact is written only by the trusted Action job. Pull-request code and
model subprocesses receive neither artifact write credentials nor access to
the manifest adapter. Persisted values exclude credentials, raw endpoints,
prompts, full patches, and unbounded provider errors. Failure reasons are
sanitized and bounded before serialization.

### requirement-manifest-bounds

One artifact is allowed per admitted run attempt. The final manifest is at
most 512 KiB compressed, 2 MiB uncompressed, 2,048 items, 200 selected paths,
64 failure records, 32 retry records, and 20 limitations. Paths are at most
512 bytes; retained findings are at most 40; other persisted strings are at
most 2,000 bytes. Evidence excerpts
obey the tighter FindingEvidence bound. Before model work, the planner
checks item, path, lane, and maximum-result bounds against these limits.
Immediately before upload, the adapter measures actual canonical bytes and
compressed bytes. A breach fails without upload or final comment write and
preserves the prior checkpoint. An uncertain upload is not a valid
ManifestReference until the artifact identity and digest are verified.

Set an explicit bounded GitHub Actions artifact retention period, no longer
than 30 days. Normal GitHub expiration owns deletion. The first release does
not claim per-PR or repository-wide storage reservations or artifact
compaction. Platform quota or upload failure blocks publication and is
visible in the Action result; it never silently reduces the denominator.

### requirement-provenance-and-rule-trust

Provenance must include reviewer version, provider and model identity,
configured concurrency, runtime configuration hash, resolved rule-set hash,
and background-context hash when that context can affect the result. Hashes are
computed from canonical serialized values before model work and recorded in
the sealed manifest.

Rule resolution is deterministic and ordered: per-run, project, global, then
embedded system rules. Per-run rules are accepted only from Action-owned,
strictly typed workflow or deployment configuration resolved before checkout.
Project rules may come only from an allowlisted path at trusted target revision
`B`; global rules come from the Action installation; embedded rules are pinned
to the reviewer version. Pull-request text, review comments, the untrusted head,
and agent output cannot supply rules. A missing, malformed, untrusted, or
changed rule source fails closed.

The manifest records the winning rule layer and bounded selection explanation
for each reviewed or excluded path. It also records bounded retry and
limitation explanations so consumers can reconstruct why an item was reviewed,
skipped, completed, or failed.

## Detailed design or contracts

The trusted sequence is:

1. Resolve immutable scope, trusted rules, configured lanes, and complete
   evidence inventory; seal the denominator before model work.
2. Execute bounded batches and lanes; record validated results, retries,
   failures, and finding evidence in the run-local manifest.
3. Finalize missing outcomes, reconcile findings and dispositions, derive
   execution statuses, and seal canonical bytes.
4. Verify the final artifact size, upload it once, and verify its identity and
   digest. If any check fails, publish no v5 report.
5. Pass the verified ManifestReference to the queued final publisher. Only its
   confirmed single comment write can advance the PR checkpoint.

The manifest is execution evidence, not a second finding or checkpoint store.
A model cannot widen scope, alter provenance, mark an item complete without
the expected lane results, or raise a bound.

## Failure and edge cases

| Case | Required result |
| --- | --- |
| Selected item or lane lacks a validated outcome | Mark the item failed; coverage incomplete; block publication. |
| Failed or waived item | Preserve reason; do not render complete or admissible. |
| Artifact exceeds a bound or upload fails | Publish no v5 report; preserve prior checkpoint. |
| Uploaded artifact identity or digest is uncertain | Do not use its reference or claim publication. |
| Rule source comes from PR text, head content, or agent | Reject it and fail closed. |
| Provider emits an unbounded error | Persist only a sanitized bounded failure class and reason. |

## Migration

Existing runs without a manifest are not reusable under this contract. The
first scope-capable publication uploads one review.run-manifest/v1 artifact
and records its verified reference in v5 state. No legacy comment, metrics
ledger, or progress marker is treated as a manifest.

## Verification

- Test strict schema parsing, canonical serialization, deterministic ordering,
  duplicate identities, and malformed or oversized values.
- Test exact path, batch, evidence-form, hunk, and lane membership. Reject
  missing or duplicate lane results, failed retries, and successful lanes
  masking a failed required lane.
- Test zero-hunk evidence for both forms, binary and mode-only changes,
  absent paths, duplicate tuples, and hunk ordinals across batches.
- Test completed, failed, and authorized waived outcomes; missing outcomes
  become failed/unknown and cannot advance the checkpoint.
- Test finding evidence digest binding and located, unlocated, and ambiguous
  status against frozen evidence.
- Test one final upload per run, pre-upload size rejection, upload/readback
  uncertainty, access control, redaction, retention, expiry, and platform
  quota failures.
- Test trusted rule precedence and provenance hash changes. A sealed
  manifest's bytes and digest remain unchanged after publication outcomes.
- Test independent coverage, finding, publication, and admission statuses
  and checkpoint blocking for every incomplete or stale state.
- Run the repository test-mapping check, documentation checks, and
  git diff --check.

## Acceptance criteria

- Every run that reaches finalization has a versioned, integrity-checked
  run-local manifest with a sealed denominator and one terminal outcome per
  selected item. Upload or quota failure leaves the Action failed and the
  previous checkpoint intact.
- Every configured lane for each selected item has a validated result before
  that item counts as complete.
- Missing, failed, waived, stale, or unverified work is visible and cannot
  advance the checkpoint.
- The final artifact has explicit per-run bounds and bounded retention; no
  external coordinator or cross-run resume is required.
- Trusted, typed, hashed rule sources and bounded finding evidence are
  recorded without accepting rules from PR content or agents.
- The verified manifest reference is carried into the trusted report, while
  the versioned-comment contract remains the sole checkpoint owner.

## Delivery state

This specification defines intended behavior. Implementation is pending.

## Traceability

- Scope and checkpoint: [spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Trusted state and publication: [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- Artifact retention: [GitHub Actions artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- Delivery: [task.incremental-pull-request-review-scope](../tasks/2026-09-13-incremental-pull-request-review-scope.md)
