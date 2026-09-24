---
id: task.serialize-code-review-publication
title: Serialize Final Code Review Publication
status: planned
owners:
  - core
created: 2026-09-14
updated: 2026-09-24
upstream:
  - spec.github-native-review-publication
  - task.unify-code-review-comment-state
  - task.persist-code-review-run-artifacts
supersedes: []
---

# Serialize Final Code Review Publication

## Objective

Publish one complete review comment after model work through a per-PR queue.

## Upstream requirements

Implement `requirement-final-publication` in
[spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md).
This task follows [task.unify-code-review-comment-state](./2026-09-14-unify-code-review-comment-state.md)
and [task.persist-code-review-run-artifacts](./2026-09-14-persist-code-review-run-artifacts.md).

## Scope

- Keep cancellable review computation separate from non-cancelling final
  publication. The unqueued producer uploads the candidate and dispatches a
  separate publisher. Use the specification's writer mutex for review publishers.
- Remove v5 progress, inline, and cleanup comment writes. Show progress in
  Action job and step status.
- After queue admission, re-read the live PR and trusted comment.
- Validate head, target, base, scope, report identity, and checkpoint before
  one final create or update.
- Consume the verified authority index and empty-state baseline. Defer
  incomplete or duplicate comment discovery to reconciliation.
- Bind final state revision, writer/source identity, and payload digest.
  Reconcile ambiguous responses by matching the exact bot comment ID,
  operation, artifact reference, digest, and body bytes, without duplicate
  writes.
- Commit the checkpoint and artifact reference only through the confirmed
  final summary. Trigger candidate-artifact cleanup on proven failure.
- Show queue overflow, cancellation, stale result, uncertain write, and
  artifact cleanup failures in the Action result.
- Connect the typed producer and publisher link to source-led replay. Preserve
  source identity and fail closed on ambiguous writes.

## Out of scope

- A DynamoDB lease, journal, or branch used as a lock.
- Publication for failed, incomplete, or invalid review execution.

## Implementation plan

1. Split computation and artifact upload from the separately dispatched final
   publisher. Grant only the queued publisher bot write permission.
2. Reconcile live comment state in the publisher. Render from the strict state
   supplied by the comment-state task.
3. Write once with an operation identity. Resolve uncertain results by
   readback; fail closed when still unknown.
4. Connect artifact registration and source-led replay. Update docs and hosted
   workflow checks.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `libs/action-code-review/src/workflows/publication-workflow.ts`
- `libs/action-code-review/src/review-run.ts`
- `libs/action-code-review/src/publication-state.ts`
- `libs/action-code-review/README.md`

## Verification

- Run test mapping and focused Action tests for stale identity, two baseline
  publishers, exact readback, writer overflow,
  producer and publisher registration, replay, and duplicate comments.
- Run a hosted baseline and follow-up; verify one final summary write and
  no v5 progress or inline comments. Run docs validation and diff checks.

## Completion criteria

- A newer review cancels stale computation without cancelling an active
  publisher.
- A failed, stale, or uncertain attempt cannot advance the checkpoint.
- A confirmed publication has exactly one complete comment state and one
  verified artifact reference.

## Outcome

Implementation pending.

## Delivery state

Planned. No target-branch delivery claim is made here.

## Traceability

- Contract: [spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md)
- State dependency: [task.unify-code-review-comment-state](./2026-09-14-unify-code-review-comment-state.md)
- Artifact dependency: [task.persist-code-review-run-artifacts](./2026-09-14-persist-code-review-run-artifacts.md)
- Follow-on proposal: [PR #112](https://github.com/marcolink/seqlane/pull/112)
