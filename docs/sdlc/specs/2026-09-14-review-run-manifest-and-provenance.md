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

This specification defines the machine-readable manifest for one admitted
pull-request review. It makes selected work, per-item outcomes, provenance,
limitations, resume reuse, and terminal status auditable without placing the
complete execution trace in the trusted pull-request comment.

The [incremental review scope specification](./2026-09-13-incremental-pull-request-review-scope.md)
owns `P(B,H)`, `D(C,H)`, `E`, `X`, `R`, and checkpoint semantics. The
[versioned comment specification](./2026-09-05-versioned-pull-request-review-comments.md)
owns the trusted summary, lifecycle state, and publication state machine. This
specification owns the manifest contract and its Action-owned persistence.

## Goals

- Make the selected denominator and every terminal outcome explicit.
- Preserve enough bounded provenance to explain selection, rules, retries, and
  failures.
- Permit strict, narrow item-level resume reuse without trusting model output.
- Bound manifest size, retention, and write amplification before model work.
- Make incomplete coverage or invalid integrity visible and non-admissible.

## Non-goals

- Replacing the trusted pull-request comment as the cross-run checkpoint.
- Storing complete patches, prompts, credentials, or provider logs.
- Defining pull-request scope, finding lifecycle, or publication ownership.

## Terminology

- **Manifest snapshot**: one immutable canonical serialization of manifest
  state, identified by a sequence number and SHA-256 digest.
- **Selected path set**: the sealed `R` supplied by the scope selector.
- **Manifest item**: the smallest path, evidence-form, and hunk unit whose
  outcome can be accounted for exactly once.
- **Settled checkpoint**: an item outcome that is complete and validated and is
  eligible for compatible reuse.
- **Provenance**: immutable input, rule, runtime, reviewer, and model identity
  recorded as hashes or bounded values.

## Requirements

### requirement-versioned-manifest

Every admitted run must create a strict manifest with schema identifier
`review.run-manifest/v1` before model work. Its identity and frozen input must
include the run ID, optional parent run ID, pull-request number, mode, target
and head revisions, checkpoint revision when applicable, source artifact or
diff hash, and the exact `ScopeIdentity` from the scope specification.

The manifest stores execution statuses `coverage` and `finding`. The publisher
joins these with `publication` and derived `admission` in the strict
[run status contract](./2026-09-05-versioned-pull-request-review-comments.md#requirement-run-status-gates).
Publication evidence belongs to the publisher's journal, never to a sealed
execution snapshot. Empty collections use `[]`; all paths, items, outcomes,
failures, retries, findings, and limitations are sorted deterministically.

### requirement-manifest-items

The sealed selected work denominator is a typed set of manifest items:

```text
ManifestItem =
  | {
      kind: "path"
      itemId: "path:<validated-relative-path>"
      path: validated relative path
      batchOrdinal: positive integer
      evidenceForm: "path"
      hunkOrdinal: 0
    }
  | {
      kind: "hunk"
      itemId: "<evidence-form>:<validated-relative-path>:<hunk-ordinal>"
      path: validated relative path
      batchOrdinal: positive integer
      evidenceForm: "pr-patch" | "change-evidence"
      hunkOrdinal: positive integer
    }
```

The selector emits a path item only when that evidence form has no hunks; it
emits one hunk item for every expected hunk otherwise. `itemId` is unique
within one manifest. The union of item paths must equal the sealed selected
path set `R`, and each item must identify its exact batch, evidence form, and
hunk. The manifest stores exactly one terminal outcome for each item:
`completed`, `reused`, `failed`, or `waived`.

Coverage is complete only when every item is `completed` or a validated
`reused` checkpoint, every expected batch and hunk is accounted for, and no
required evidence is missing. A `failed` item makes coverage incomplete and
blocks publication. A `waived` item requires a deterministic reason and
authorizing policy; it also makes coverage incomplete, blocks publication, and
blocks automation admission. Neither outcome can be treated as completed.

### requirement-reuse-proof

Terminal outcomes are a strict discriminated union. A `completed` outcome
contains the item ID, validated result and evidence references, and their
canonical SHA-256 digests. A `reused` outcome contains these required fields:

```text
{
  outcome: "reused"
  itemId
  source: {
    manifestReference: ManifestReference
    itemId
    outcomeDigest: lowercase SHA-256
  }
  compatibilityInputHash: lowercase SHA-256
}
```

`ManifestReference` identifies repository, workflow run and attempt, artifact
ID, manifest run ID, pull-request number, reviewed revision, `ScopeIdentity`,
schema version, snapshot sequence, and canonical snapshot SHA-256. IDs must be
nonempty and sequences nonnegative integers. Retrieval
for reuse or final publication must establish that the referenced snapshot is
sealed and belongs to the trusted repository and workflow. A progress notice
may reference the initial snapshot but cannot present it as final evidence.

Before recording `reused`, the adapter must retrieve and verify the source
snapshot, its item, outcome digest, and referenced result and evidence. The
source outcome must be `completed`; reuse chains must reference their original
completed source directly. The source item must match the destination's exact
path, batch, evidence form, hunk, and frozen evidence digest.

The adapter computes `compatibilityInputHash` locally from canonical schema and
normalizer versions, mode, `ScopeIdentity`, frozen input, selected item and lane
plan, rules, filters, provider, model, reviewer, and runtime configuration.
Frozen input includes retained finding and disposition state supplied to lanes.
Both source and destination hashes must equal this value. Model output cannot
provide proof or select a reusable outcome. Missing evidence, a mismatched
digest, or incompatible input requires fresh execution within the remaining
budget; until then the item cannot count toward complete coverage.

### requirement-manifest-lifecycle

The manifest seals the selected denominator before concurrency or resume reuse
starts. Repeated identical transitions are idempotent; conflicting transitions
fail. Finalization rejects later mutation and converts every selected item
without an outcome into a typed `unknown` failure. Failure is recorded at the
narrowest known level using one of `provider`, `timeout`, `cancelled`,
`configuration`, `input`, `budget`, `panic`, or `unknown`. An item failure does
not by itself determine the run-level terminal state.

The manifest records an execution outcome of `complete`, `partial`, `failed`,
`cancelled`, or `stale`. `complete` requires complete coverage and valid finding
output. `stale`, then `cancelled`, take precedence when observed before sealing;
otherwise incomplete execution is `partial` if any item succeeded, or `failed`.
Execution completion does not mean publication succeeded or automation admitted
the result. Later publication failures are recorded only in the journal.

### requirement-manifest-persistence

The Action-owned manifest adapter is the sole persistence owner. It writes a
validated canonical snapshot to an immutable GitHub Actions artifact scoped to
the trusted repository and workflow run. The initial snapshot contains the
sealed denominator and provenance before model work. Later snapshots use
monotonic append-only sequence numbers; each snapshot has its own SHA-256
digest. The final snapshot is explicitly sealed before inline or final report
publication; an early progress notice may reference the initial snapshot. A sealed
snapshot cannot be mutated or replaced under the same identity.

Retries may retrieve only artifacts from the same trusted workflow and
repository. Retrieval must verify artifact identity, schema version,
`ScopeIdentity`, sequence continuity, canonical serialization, and digest before
reuse. The trusted v5 report must store a complete `ManifestReference` to the
final sealed snapshot plus a bounded manifest summary. Missing or malformed
references are `invalid-current` state and fail closed, never legacy input.
Missing, expired, unauthorized, or integrity-failing artifacts disable reuse
and require a fresh bounded run; they never permit
partial recovery or a fabricated audit trail.

Artifact expiry does not remove the reference from a published report or
invalidate its otherwise valid Git checkpoint. A subsequent run uses that
checkpoint with fresh execution evidence and records that prior audit evidence
is unavailable. It cannot claim resumed work from an unavailable artifact.

Manifest artifacts are inaccessible to pull-request code and are written with
the workflow's trusted token. Persisted data must redact credentials, raw
endpoints, prompts, and unbounded provider errors. Failure reasons are bounded
and sanitized before persistence.

### requirement-manifest-bounds

The manifest has these per-snapshot limits: 512 KiB compressed, 2 MiB
uncompressed, 2,048 items, 200 selected paths, 64 failure records, 32 retry
records, and 20 limitations. Paths are at most 512 bytes; other persisted
strings are at most 2,000 bytes. Evidence bodies and repeated explanations use
SHA-256 hashes plus bounded references instead of duplication.

Aggregate storage and write amplification are also bounded: at most 16
snapshots and 32 MiB per run, 128 snapshots and 256 MiB per pull request in a
30-day retention window, and 1,024 snapshots and 1 GiB per repository in that
window. The adapter reserves capacity before model work and before each write.
It may compact snapshots only by writing a new digest-verified full snapshot
that preserves the sequence chain and final sealed state. A capacity breach or
unknown size fails closed without publication.

### requirement-provenance-and-rule-trust

Provenance must include reviewer version, provider and model identity,
configured concurrency, runtime configuration hash, resolved rule-set hash,
and background-context hash when that context can affect the result. Hashes are
computed from canonical serialized values before model work and are required
for resume admission.

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
skipped, reused, or failed.

### requirement-strict-resume

Resume reuse requires exact equality of mode, `ScopeIdentity`, frozen input,
rules, filters, provider, model, reviewer version, and runtime configuration.
Only item checkpoints with a validated reuse proof may be reused. Validate
source proofs before creating the destination manifest or entering model work.
Missing, invalid, unverified, or stale items require fresh work in that
destination under the remaining budget. A retry of a sealed run creates a new
manifest run ID with the source as parent; it cannot append outcomes to the
sealed manifest. Uncertain configuration identity never narrows scope.

## Detailed design or contracts

The trusted sequence is:

1. Resolve and validate immutable scope and trusted configuration.
2. Create the manifest with provenance, sealed selected paths, typed item
   denominator, zeroed budgets, and sequence `0`.
3. Reserve capacity, execute evidence collection and model work, and append
   validated item outcomes and bounded failure or retry records.
4. Reconcile findings and dispositions, derive the verdict, finalize execution
   statuses, and seal the final snapshot and digest.
5. Pass the sealed manifest reference to the publisher, which records subsequent
   transitions in its append-only journal. Publication may advance
   the pull-request checkpoint only when its own canonical publication state
   reaches `published`.

The manifest is execution evidence, not a second finding or checkpoint store.
Its item IDs and outcome keys are deterministic and never allocated by an
agent. A model cannot widen the selected path set, alter provenance, mark an
item reused, or raise any bound.

## Failure and edge cases

| Case | Required result |
| --- | --- |
| Selected item has no outcome at finalization | Add typed `unknown` failure; coverage incomplete; block publication. |
| Failed or waived item | Preserve reason; do not render complete or automation-admissible. |
| Artifact missing or digest mismatch | Disable reuse; start a fresh bounded run. |
| Aggregate snapshot or byte limit reached | Fail closed; preserve prior checkpoint. |
| Rule source is supplied by PR text, head content, or agent | Reject it and fail closed. |
| Resume identity differs in any field | Reuse no items; recompute bounded work. |
| Provider emits an unbounded error | Sanitize and persist only a bounded failure class and reason. |

## Migration

Existing runs without a manifest are not resumable through this contract. The
first scope-capable publication creates a new `review.run-manifest/v1` artifact
and records its digest in the trusted state. No legacy comment, metrics ledger,
or progress marker is treated as a manifest.

## Verification

- Test strict schema parsing, canonical serialization, deterministic ordering,
  empty-array encoding, and malformed or oversized snapshots.
- Test the typed item union, exact path/batch/evidence/hunk identity, one-to-one
  outcomes, failed and waived coverage, finalization backstop, and conflicting
  transitions.
- Test artifact creation, sequence continuity, digest validation, access
  control, redaction, expiry, aggregate per-run/pull-request/repository bounds,
  and safe compaction.
- Test exact resume identity, narrow item reuse, missing checkpoints, rule
  precedence, trusted-source rejection, and provenance hash changes.
- Reject forged source IDs, altered outcome digests, missing source evidence,
  reuse chains, and changed compatibility inputs before counting coverage.
- Test a sealed execution snapshot followed by successful, failed, and uncertain
  publication. Its bytes and digest must remain unchanged in every case.
- Test mandatory v5 references separately from expired artifacts: malformed
  references fail closed; expiry disables reuse without resetting Git scope.
- Test independent coverage, finding, publication, and admission statuses and
  checkpoint blocking for every incomplete or stale state.
- Run the repository test-mapping check, `pnpm docs:index`,
  `pnpm docs:validate`, and `git diff --check`.

## Acceptance criteria

- Every admitted run has one versioned, integrity-checked manifest with a sealed
  denominator and exactly one outcome per selected item.
- Missing, failed, waived, stale, or unverified work is visible and cannot
  appear as complete or advance the checkpoint.
- Manifest artifacts have explicit per-snapshot and aggregate bounds and a
  bounded retention policy.
- Resume reuse validates all frozen input, rule, runtime, reviewer, and model
  identity before creating state.
- Rule sources are trusted, typed, hashed, and explainable; agent and PR content
  cannot alter them.
- The manifest reference and digest are carried into trusted publication while
  the versioned-comment contract remains the sole checkpoint owner.

## Delivery state

This specification defines intended behavior. Implementation is pending.

## Traceability

- Scope and checkpoint: [spec.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Trusted state and publication: [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- Delivery: [task.incremental-pull-request-review-scope](../tasks/2026-09-13-incremental-pull-request-review-scope.md)
