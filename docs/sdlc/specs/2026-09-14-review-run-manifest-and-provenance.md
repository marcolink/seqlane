---
id: spec.review-run-manifest-and-provenance
title: Review Run Manifest and Provenance
status: active
owners:
  - core
created: 2026-09-14
updated: 2026-10-05
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Review Run Manifest and Provenance

## Summary

This specification defines one execution manifest for each review that reaches
finalization. It records the frozen scope, configured review
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

Every admitted run creates a run-local review.run-manifest/v1 value before model
work. This value is in memory. Admission does not promise a durable artifact.
Its frozen input includes run ID, pull-request number, mode, target, base,
head, checkpoint when applicable, and exact ScopeIdentity.
It also includes selected paths, evidence digests, configured lanes, and rule-set hash.
It records reviewer version, provider and model identity, and relevant
runtime-configuration hashes.
No model output can change this input or the selected denominator.

The manifest stores execution statuses coverage and finding. The publisher
joins them with publication and derived admission under the
[run status contract](./2026-09-05-versioned-pull-request-review-comments.md#requirement-run-status-gates).
Empty collections use []; canonical ordering is mandatory for artifact bytes
and digest validation. Publication evidence belongs to the trusted report,
never to the sealed execution manifest.

The durable manifest guarantee begins only after finalization and verified
upload. Cancellation or termination before that point can leave no artifact.
The GitHub workflow run and attempt record the incomplete admission or failure.
They do not prove a frozen denominator or individual terminal outcomes.
Recovery starts a fresh review when no verified sealed candidate exists.
It cannot claim coverage, replay model work, or advance a checkpoint from the
workflow run record alone.

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
| Retained findings | Canonical order from [RetainedFinding](./2026-09-05-versioned-pull-request-review-comments.md#requirement-retained-finding); unallocated candidates are excluded. |
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

This specification owns the strict evidence and location models. The scope
gate validates them before stable-ID allocation. Both persistence sinks reuse
these schemas and the same validated
[RetainedFinding](./2026-09-05-versioned-pull-request-review-comments.md#requirement-retained-finding)
values. Unknown fields fail validation.

```text
EvidenceExcerpt =
  | { kind: "clear"
      value: nonempty UTF-8 string, at most 500 bytes
      excerptDigest: lowercase SHA-256 of original excerpt bytes }
  | { kind: "withheld"
      excerptDigest: lowercase SHA-256 of original excerpt bytes
      redactionPolicyId: "review.secret-redaction/v1"
      ruleIds: 1 to 8 trusted rule IDs, each at most 64 bytes }

FindingEvidence = {
  itemId: sealed ManifestItem ID
  evidenceForm: "pr-patch" | "change-evidence"
  itemEvidenceDigest: lowercase SHA-256 matching that item
  path: validated relative path, at most 512 bytes
  supportingEvidence: array of at most 4 {
    role: "cause" | "source" | "sink" | "guard"
    path: validated relative path, at most 512 bytes
    sourceRevision: full Git commit SHA
    sourceDigest: lowercase SHA-256
    excerpt: EvidenceExcerpt
  }
} & (
  | { anchorKind: "changed-text"
      side: "old" | "new"
      sourceRevision: full Git commit SHA
      sourceDigest: lowercase SHA-256 of frozen source bytes
      excerpt: EvidenceExcerpt
      changedStartLine: positive integer
      changedEndLine: integer >= changedStartLine }
  | { anchorKind: "changed-tree-entry"
      beforeEntryDigest: lowercase SHA-256 or absent
      afterEntryDigest: lowercase SHA-256 or absent }
)

LocationStatus =
  | { kind: "located"; side: "old" | "new";
      startLine: positive integer; endLine: integer >= startLine }
  | { kind: "unlocated"; reason: sanitized nonempty string, at most 2,000 bytes }
  | { kind: "ambiguous"; reason: sanitized nonempty string, at most 2,000 bytes;
      candidateCount: positive integer }
```

The [scope admission rules](./2026-09-13-incremental-pull-request-review-scope.md#requirement-new-finding-admission)
own eligible changed causes and identity derivation. The finalizer validates
original source bytes before redaction. Withheld excerpts retain source digests
and locally proved locations. Redaction cannot validate missing or false evidence.
A new finding references one current sealed item. Carried findings keep the
evidence origin defined by the retained-finding contract.

### requirement-evidence-redaction

The trusted finalizer applies `review.secret-redaction/v1` before artifact
serialization and before constructing trusted comment state. The renderer
consumes only that sanitized state. Markdown escaping does not remove secrets.
The policy ID, ordered rule IDs, and policy digest belong to frozen provenance.
PR content and model output cannot change the policy.

The policy includes deterministic rules for these values:

- Private-key PEM blocks, including multiline content.
- GitHub tokens with `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, or `github_pat_` prefixes.
- AWS access-key IDs and their secret-key assignment values.
- API keys and bearer credentials with recognized provider or authorization prefixes.
- Values assigned to password, secret, token, API-key, client-secret, or private-key names, ignoring name case.
- Exact known credential values from the trusted runtime, without persisting those values in policy metadata.

Each rule has a pinned bounded matcher and representative fixtures.
The implementation tests multiline, quoted, escaped, and nested-field inputs.
It scans every persisted text field, including findings, verification, failure
reasons, limitations, and provenance. It never stores raw input in failure logs.
An unsafe or unclassifiable excerpt becomes `withheld`. No unsafe substring survives.
Other unsafe text becomes `[redacted]` and adds a bounded redaction limitation.
Identity fields and paths cannot be rewritten into display placeholders.
If they contain unsafe text, validation fails before persistence.
If safe serialization cannot be proved, publication fails before either sink.

Identity and source hashes come from locally validated original bytes before
redaction. The stored identity inputs contain the cause digest, not secret text.
Clear excerpts must match their digest. Withheld excerpts retain the original
digest, policy ID, rule IDs, and hash-and-location evidence only.
Their variants cannot contain a `value` field. Later readers validate the
stored identity from its typed digest inputs without reconstructing secret text.

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
ManifestReference to the final publisher. This specification owns its strict schema:

```text
ManifestReference = {
  schemaVersion: 1
  manifestSchema: "review.run-manifest/v1"
  repositoryId: decimal GitHub repository ID, at most 128 bytes
  pullRequestNumber: positive integer
  workflowId: decimal GitHub workflow ID, at most 128 bytes
  workflowPath: trusted relative workflow path, at most 512 bytes
  workflowDefinitionRevision: full trusted Git commit SHA
  workflowRunId: decimal GitHub workflow run ID, at most 128 bytes
  workflowAttempt: positive integer
  manifestRunId: trusted review run ID, at most 128 bytes
  reviewedRevision: full Git commit SHA
  scopeIdentityDigest: lowercase SHA-256
  artifactId: decimal GitHub artifact ID, at most 128 bytes
  artifactName: canonical nonempty name, at most 256 bytes
  compressedBytes: positive integer, at most 512 KiB
  uncompressedBytes: positive integer, at most 2 MiB
  digest: lowercase SHA-256 of canonical uncompressed manifest bytes
  readback: "verified"
}
```

IDs are nonzero decimal strings. Unknown fields and snapshot sequences fail
validation. The adapter binds the fetched artifact to the exact repository,
allowlisted default-branch workflow definition, run, attempt, and canonical name.
The definition revision must be reachable from the trusted default branch.
Compressed bytes count the archive entry's compressed manifest payload.
Uncompressed bytes count its canonical manifest bytes. Both declared counts
must match measured entry bytes. Outer archive limits remain subject to the
pending storage-budget alignment. This model does not change those budgets.
Stream limits apply before archive extraction, decompression, UTF-8 decoding,
JSON parsing, or hashing. Duplicate entries, traversal paths, symlinks, unexpected
entries, malformed bytes, and noncanonical JSON fail validation.

The publisher downloads that exact artifact and repeats ownership, schema,
canonical-byte, scope, revision, size, and digest validation before queue entry.
It repeats live publication guards inside the queue. Failed, missing, or unknown
readback prevents a verified reference and any comment write.
Only successful measured readback produces `readback: "verified"`.
That field does not replace the publisher's independent validation.

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
3. Finalize missing outcomes, reconcile findings, derive
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
| Cancellation before finalization or verified upload | Actions records incomplete admission; no artifact or checkpoint is promised. |
| Evidence excerpt contains a secret or cannot be safely classified | Persist only the bounded withheld variant, source hashes, and validated location. |

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
- Test the canonical RetainedFinding and ManifestReference schemas at both
  persistence boundaries. Reject unknown fields, wrong repository or workflow,
  wrong run or attempt, mismatched scope, sizes, digests, and failed readback.
- Test bounded extraction, duplicate or unexpected entries, traversal paths,
  malformed UTF-8, noncanonical JSON, and expansion beyond declared sizes.
- Test cancellation before admission completes, during model work, and before
  verified upload. Reconcile incomplete Actions runs without inventing outcomes.
- Test pinned redaction fixtures for PEM, GitHub, AWS, provider, bearer, and
  sensitive-assignment values, including multiline, quoted, escaped, and nested input.
  Check both artifact bytes and hidden state. Unsafe excerpts retain matching
  digest inputs and validated location, with no raw credential or value field.
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
- Early cancellation has an explicit incomplete Actions record and no promised
  persisted denominator. Recovery cannot advance a checkpoint from that record.
- Both sinks use canonical finding and evidence models with trusted redaction.
  Unsafe excerpts preserve validated identity and location without source secrets.
- The verified manifest reference is carried into the trusted report, while
  the versioned-comment contract remains the sole checkpoint owner.

## Delivery state

This specification defines intended behavior. Implementation is pending.

## Traceability

- Scope and checkpoint: [spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Trusted state and publication: [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- Artifact retention: [GitHub Actions artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- Delivery: [task.incremental-pull-request-review-scope](../tasks/2026-09-13-incremental-pull-request-review-scope.md)
