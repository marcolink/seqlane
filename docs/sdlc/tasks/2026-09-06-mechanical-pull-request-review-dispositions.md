---
id: task.mechanical-pull-request-review-dispositions
title: Apply Pull Request Review Dispositions Without Agent Runs
status: cancelled
owners:
  - core
created: 2026-09-06
updated: 2026-09-24
upstream:
  - spec.mechanical-pull-request-review-dispositions
supersedes: []
---

# Apply Pull Request Review Dispositions Without Agent Runs

Cancelled on 2026-09-24. The repository no longer accepts comment commands
as review decisions. The active review contract is
[spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md).

Historical path note: `examples/pr-code-review.ts` was superseded by `workflows/code-review/workflow.ts`; `examples/README.md` by `workflows/README.md`.

## Objective

Apply authorized `wont-fix` and `downgrade` decisions promptly and safely,
without starting an agentic review. Preserve every decision when it arrives
while a full review is computing or publishing.

## Upstream requirements

Implement [spec.mechanical-pull-request-review-dispositions](../specs/2026-09-06-mechanical-pull-request-review-dispositions.md).

## Scope

- Make `/seqlane review` and eligible pull-request events the only full-review
  triggers.
- Let the next pushed-head review verify every retained finding automatically;
  retain `/seqlane fixed` only as an optional non-authoritative claim that
  starts no workflow.
- Add a mechanical workflow path for authorized `wont-fix` and `downgrade`
  commands, including relevant comment edits.
- Move authoritative-comment writes behind one per-pull-request queued writer
  lock shared by the mechanical path and full-review publication.
- Re-read the live comment and command ledger inside the lock, and reconcile
  an agent result with decisions that appeared after the review began.
- Add a monotonic state revision and writer identity. Migrate v3 to v4 only if
  this task lands before incremental review scope; otherwise use the current
  generation-qualified schema.
- Preserve and safely clear the existing run-specific progress marker.
- Keep slash-command syntax out of the human projection until this task's
  mechanical disposition path is complete and verified.

## Out of scope

- Changing agent prompts, specialist lanes, or their read-only policy.
- Executing pull-request code, tests, builds, or scripts.
- Adding a public package or workflow-authoring contract.
- Retaining unbounded comment or disposition history.

## Implementation plan

1. Extract the strict state decoding, command-ledger collection, lifecycle
   reconciliation, and safe Markdown rendering from the example into a
   reusable, pure module with schemas as the contract source.
2. Add `stateRevision` and a writer identity, but keep command comments as the
   source of human decisions. Coordinate the state version with
   `spec.incremental-pull-request-review-scope`; never use one version number
   for two incompatible schemas.
3. Split the current workflow into review computation (cancellable for
   obsolete heads), a shared queued publication job, and a mechanical
   disposition job. Use the same publication concurrency group with
   `cancel-in-progress: false` and a queue that retains every pending writer.
4. Let the mechanical job fetch the live trusted report and bounded current
   ledger after it owns the publication queue. Validate authority, current
   command syntax, and finding identity; apply only `wont-fix` or `downgrade`;
   render and write the next state without checking out the review target or
   starting OpenCode.
5. Before a completed review writes, acquire the same queue, fetch the live
   report and ledger again, and run the pure reconciler with its model output.
   Preserve newer manual dispositions and only then render the replacement.
6. Put progress-marker writes and cleanup through the shared writer protocol.
   Mechanical mutations must preserve another run's marker; cleanup removes
   only the marker owned by its run.
7. Update command help and explain that the next pushed-head review verifies
   retained findings automatically, while `wont-fix` and `downgrade` are
   immediate mechanical updates. Decide whether to keep `fixed` as a quiet
   compatibility alias or remove it from displayed help.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `examples/pr-code-review.ts` and extracted review-comment state modules
- `apps/cli/src/pr-code-review-example.spec.ts`
- workflow-script tests for YAML and publisher behavior
- `examples/README.md`
- `docs/sdlc/specs` and `docs/sdlc/tasks`

## Verification

- Run `pnpm run test:mapping` before scoped tests.
- Add pure-module tests for v1-v4 migration, disposition edits, and invalid or
  unknown commands.
- Add workflow tests that assert mechanical commands neither start OpenCode nor
  invoke the Seqlane CLI.
- Test these publication interleavings: decision during agent computation,
  decision queued behind review publication, two decisions for one finding,
  and an edited or removed command.
- Run the focused CLI and workflow-helper tests, YAML validation, formatting,
  `pnpm docs:index`, and `pnpm docs:validate`.
- Run the branch workflow against an open pull request and inspect the
  authoritative comment, v4 state, audit comments, and progress cleanup.

## Completion criteria

- `wont-fix` and `downgrade` update a valid existing report without agent work.
- `fixed` alone does not start a workflow, and the next pushed-head review
  verifies every retained finding whether or not that claim exists.
- No full review publication can erase a human disposition that arrived after
  the review started.
- Command edits converge to the latest authorized command without replaying
  stale webhook data.
- Only one queued writer changes an authoritative comment at a time, and every
  writer reconstructs from the current state and ledger after obtaining the
  queue.
- State migration, malformed input, stale-head protection, and progress-marker
  ownership remain covered by automated tests.

## Outcome

Cancelled before delivery. Comment commands are no longer part of the review
process.

## Delivery state

No delivery claim. The historical requirements above are withdrawn.

## Traceability

- Contract: [spec.mechanical-pull-request-review-dispositions](../specs/2026-09-06-mechanical-pull-request-review-dispositions.md)
- Review scope: [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md)
- Current contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Prior delivery: [Publish Versioned Pull Request Review Comments](2026-09-05-publish-versioned-pull-request-review-comments.md)
- Planning and prerequisite: [pull request 58](https://github.com/marcolink/seqlane/pull/58)
