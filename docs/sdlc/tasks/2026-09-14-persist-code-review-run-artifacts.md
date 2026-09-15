---
id: task.persist-code-review-run-artifacts
title: Persist Bounded Published Review Artifacts
status: planned
owners:
  - core
created: 2026-09-14
updated: 2026-09-15
upstream:
  - spec.github-native-review-publication
supersedes: []
---

# Persist Bounded Published Review Artifacts

## Objective

Retain bounded structured evidence for confirmed published reviews without
making artifact availability a prerequisite for an old comment checkpoint.

## Upstream requirements

Implement `requirement-published-artifact` in
[spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md).
Do not implement against this draft alone. PR #112 must first land a canonical
manifest specification with stable ID and complete item, lane, path, finding,
and string limits.

## Scope

- Build one strict, sealed run-local manifest and bounded structured evidence.
- In the unqueued producer, upload one immutable artifact with explicit 90-day
  retention, then validate its identity, schema, compressed and uncompressed
  size, and digest before dispatching the separate queued publisher.
- Store only the verified direct artifact reference in the final comment.
- Fetch a referenced artifact by ID for specific audit or future reuse needs;
  expiry and invalid evidence must not reset a valid comment checkpoint.
- Enforce 2 MiB manifest, 512 KiB compressed manifest, 32 MiB compressed
  artifact, and 64 MiB uncompressed artifact hard bounds. Stream extraction
  through cumulative and per-entry limits before parsing or hashing.
  Report advisory PR and repository usage only when measurable; label estimates.
- Reconcile and delete a proven unpublished candidate after a failed or stale
  final write. Retain unresolved candidates until the write effect is known.
- Name candidates with PR, run ID, and attempt. Add a default-branch
  `workflow_run: completed` reconciler that lists artifacts for that run,
  confirms the publisher outcome and live comment, and deletes only a proven
  unpublished candidate. Require verified repository, default-branch workflow
  identity and file/ref, run ID and attempt, allowed event origin, same-repo
  PR, publisher job, and artifact ownership before any replay or deletion.
  Exclude PR-branch dispatches and untrusted PR code execution. Separate
  read-only inspection from a narrowly scoped `actions: write` recovery job;
  neither receives comment-write permission. Report unresolved candidates
  and let retention expire those that cannot be proven safe to delete.
- Persist scheduled scan progress in a strict, 64 KiB recovery-cursor artifact
  owned by the allowlisted recovery workflow. Limit each sweep to ten pages,
  1,000 runs, and five minutes. Continue with overlapping time boundaries;
  bisect overfull time shards; report incomplete coverage or cursor restart.

## Out of scope

- A DynamoDB capacity table, artifact journal, append sequence, or Git ref.
- Cross-run resume reuse in the first delivery.
- Raw prompts, complete patches, secrets, or unbounded model logs.

## Implementation plan

1. Add a typed Action-owned artifact adapter for producer sealing and upload,
   bounded publisher readback, direct-ID retrieval, and guarded deletion.
2. Apply byte and item bounds before upload. Verify the returned artifact
   reference and canonical digest before allowing final publication.
3. Wire the adapter to the comment-state reference. Treat expiry as missing
   audit evidence, not an invalid checkpoint.
4. Add post-run reconciliation after exact final-write readback, including
   a terminal-run trigger and scheduled sweep for cancelled or overflowed
   publishers. Replay a proven never-started publisher from its candidate;
   keep unproven candidates until later safe reconciliation or expiry.
5. Store and verify the bounded recovery cursor. Continue partial scans across
   scheduled invocations without skipping overfull time ranges.

## Affected areas

- `libs/action-code-review/src/workflows`
- `libs/action-code-review/src/review-run.ts`
- `libs/action-code-review/src/publication-state.ts`
- `.github/workflows/seqlane-code-review.yml`
- `libs/action-code-review/README.md`

## Verification

- Run test mapping and focused artifact lifecycle, expansion-boundary,
  archive-path, integrity, expiry, access, and cleanup tests. Cover
  cancellation before publisher start and uncertainty after a write starts.
  Reject wrong repository, workflow file/ref, run or artifact owner, fork,
  PR-branch dispatch, and unauthorized disposition before mutation.
- Verify cursor paging, time/run budgets, boundary overlap, shard bisection,
  cursor expiry, and visible incomplete-coverage reporting.
- Verify 90-day retention and direct-ID retrieval in a hosted Action run.
  Run docs validation and `git diff --check`.

## Completion criteria

- Each published review references one verified artifact.
- Unpublished runs add no artifact reference; known orphan candidates are
  removed only after the comment result is reconciled.
- Artifact expiry cannot erase a valid comment checkpoint.

## Outcome

Implementation pending.

## Delivery state

Planned. No target-branch delivery claim is made here.

## Traceability

- Contract: [spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md)
- Follow-on proposal: [PR #112](https://github.com/marcolink/seqlane/pull/112)
