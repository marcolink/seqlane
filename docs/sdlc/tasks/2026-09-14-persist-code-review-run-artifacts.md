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

Implement `requirement-artifact-admission` and `requirement-published-artifact` in
[spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md).
Do not implement against this draft alone. PR #112 must first land a canonical
manifest specification with stable ID and complete item, lane, path, finding,
and string limits.

## Scope

- Build one strict, sealed run-local manifest and bounded structured evidence.
- In the unqueued producer, upload and verify the bounded candidate before
  dispatching the separate queued publisher.
- Store only the verified direct artifact reference in the final comment.
- Fetch a referenced artifact by ID for specific audit or future reuse needs;
  expiry and invalid evidence must not reset a valid comment checkpoint.
- Enforce all artifact, archive-expansion, admission, rate, and retained-usage
  limits from the specification.
- Reconcile and delete a proven unpublished candidate after a failed or stale
  final write. Retain unresolved candidates until the write effect is known.
- Implement the typed store index, reservation lifecycle, producer-owned
  artifact link, publisher registration link, and bounded recovery cursor.
- Add the default-branch reconciler with the provenance and least-privilege
  boundaries from the specification. Delete only proven unpublished data.

## Out of scope

- A DynamoDB capacity table, artifact journal, append sequence, or Git ref.
- Cross-run resume reuse in the first delivery.
- Raw prompts, complete patches, secrets, or unbounded model logs.

## Implementation plan

1. Add a typed Action-owned artifact adapter for producer sealing and upload,
   bounded publisher readback, direct-ID retrieval, and guarded deletion.
2. Add serialized reservation, upload, actual-size accounting, publication,
   and cleanup transitions to the store index.
3. Register the producer and publisher link before writer-queue admission.
4. Wire verified artifact references into comment state. Treat expiry as lost
   audit evidence, not an invalid checkpoint.
5. Implement event-driven and cursor-based recovery without skipping bounded
   partial scans or retrying ambiguous writes.

## Affected areas

- `libs/action-code-review/src/workflows`
- `libs/action-code-review/src/review-run.ts`
- `libs/action-code-review/src/publication-state.ts`
- `.github/workflows/seqlane-code-review.yml`
- `libs/action-code-review/README.md`

## Verification

- Run test mapping and focused artifact, admission, index, producer-link,
  recovery, provenance, expansion, integrity, expiry, and cleanup tests.
  Cover every boundary and failure state named by the specification.
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
