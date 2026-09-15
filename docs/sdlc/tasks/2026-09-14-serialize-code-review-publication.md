---
id: task.serialize-code-review-publication
title: Serialize Final Code Review Publication
status: planned
owners:
  - core
created: 2026-09-14
updated: 2026-09-15
upstream:
  - spec.github-native-review-publication
  - spec.mechanical-pull-request-review-dispositions
  - task.unify-code-review-comment-state
  - task.persist-code-review-run-artifacts
supersedes: []
---

# Serialize Final Code Review Publication

## Objective

Publish one complete review comment after model work, through the same
per-PR queue used by mechanical dispositions.

## Upstream requirements

Implement `requirement-final-publication` in
[spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md).
This task follows [task.unify-code-review-comment-state](./2026-09-14-unify-code-review-comment-state.md)
and [task.persist-code-review-run-artifacts](./2026-09-14-persist-code-review-run-artifacts.md).
The shared queue must satisfy
[spec.mechanical-pull-request-review-dispositions](../specs/2026-09-06-mechanical-pull-request-review-dispositions.md).

## Scope

- Keep cancellable review computation separate from non-cancelling final
  publication. The unqueued producer uploads the candidate and dispatches a
  separate publisher. Use `queue: max` with the exact key
  `seqlane-review-publication-<repository-id>-<pr-number>` for all
  authoritative-comment writers, including mechanical dispositions.
- Remove v5 progress, inline, and cleanup comment writes. Show progress in
  Action job and step status.
- After queue admission, re-read live PR, trusted comment, and authorized
  command ledger. Merge dispositions made during review computation.
- Validate head, target, base, scope, report identity, and checkpoint before
  one final create or update.
- Permit zero authoritative comments only for initial creation. Fail closed
  when two or more trusted bot comments carry the authoritative marker.
- Bind final state revision, writer/source identity, and payload digest.
  Reconcile ambiguous responses by matching the exact bot comment ID,
  operation, artifact reference, digest, and body bytes, without duplicate
  writes.
- Commit the checkpoint and artifact reference only through the confirmed
  final summary. Trigger candidate-artifact cleanup on proven failure.
- Show queue overflow, cancellation, stale result, uncertain write, and
  artifact cleanup failures in the Action result.
- Replay overflowed or cancelled-before-write publishers from the sealed
  candidate or authorized command ledger. Use `workflow_run: completed` and
  a scheduled sweep so a missed recovery event cannot silently lose a write.
  Replayed runs retain source identity, recheck live state, and become no-ops
  when already published or stale. Keep ambiguous candidates until their
  effect is resolved or they expire.

## Out of scope

- A DynamoDB lease, journal, or branch used as a lock.
- Publication for failed, incomplete, or invalid review execution.

## Implementation plan

1. Split computation and artifact upload from the separately dispatched final
   publisher. Grant only the queued publisher bot write permission.
2. Reconcile live comment and command state in the publisher. Render from the
   merged strict state supplied by the comment-state task.
3. Write once with an operation identity. Resolve uncertain results by
   readback; fail closed when still unknown.
4. Connect artifact result handling, replay, and cleanup. Update docs and
   hosted workflow checks.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `libs/action-code-review/src/workflows/publication-workflow.ts`
- `libs/action-code-review/src/review-run.ts`
- `libs/action-code-review/src/publication-state.ts`
- `libs/action-code-review/README.md`

## Verification

- Run test mapping and focused Action tests for stale identity, two baseline
  publishers, concurrent disposition updates, exact readback, queue
  overflow, producer cancellation around upload, cancelled replay, duplicate
  recovery, duplicate authoritative comments, and artifact cleanup.
- Run a hosted baseline and follow-up; verify one final summary write and
  no v5 progress or inline comments. Run docs validation and diff checks.

## Completion criteria

- A newer review cancels stale computation without cancelling an active
  publisher; disposition updates survive a concurrent review.
- A failed, stale, or uncertain attempt cannot advance the checkpoint.
- A confirmed publication has exactly one complete comment state and one
  verified artifact reference.

## Outcome

Implementation pending.

## Delivery state

Planned. No target-branch delivery claim is made here.

## Traceability

- Contract: [spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md)
- Mechanical writer: [spec.mechanical-pull-request-review-dispositions](../specs/2026-09-06-mechanical-pull-request-review-dispositions.md)
- State dependency: [task.unify-code-review-comment-state](./2026-09-14-unify-code-review-comment-state.md)
- Artifact dependency: [task.persist-code-review-run-artifacts](./2026-09-14-persist-code-review-run-artifacts.md)
- Follow-on proposal: [PR #112](https://github.com/marcolink/seqlane/pull/112)
