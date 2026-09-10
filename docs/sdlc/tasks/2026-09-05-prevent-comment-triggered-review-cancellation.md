---
id: task.prevent-comment-triggered-review-cancellation
title: Prevent Irrelevant Comments from Cancelling Pull Request Reviews
status: completed
owners:
  - core
created: 2026-09-05
updated: 2026-09-08
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Prevent Irrelevant Comments from Cancelling Pull Request Reviews

## Objective

Prevent an irrelevant `issue_comment` event from cancelling an active
pull-request review while preserving intentional review replacement and close
cancellation behavior.

## Upstream requirements

Implement [requirement-workflow-admission-and-concurrency](../specs/2026-09-05-versioned-pull-request-review-comments.md#requirement-workflow-admission-and-concurrency)
from the active versioned pull-request review comments specification.

## Scope

- Move event admission into a no-permission job that runs before review
  concurrency.
- Put admitted review work in a per-pull-request job concurrency group.
- Preserve close-event cancellation with a no-op job in that group.
- Keep review write permissions scoped to the review job.
- Add workflow regression coverage and update user and SDLC documentation.

## Out of scope

- Changes to review prompts, task topology, report state, or publication format.
- Changes to recognized command syntax.
- Changes to runtime or package APIs.

## Implementation plan

1. Remove workflow-level concurrency and add the admission job.
2. Add job-level review and close-event concurrency with the same group key.
3. Add structural workflow regression assertions.
4. Update the examples README and active specification.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`
- `examples/README.md`
- `docs/sdlc/specs/2026-09-05-versioned-pull-request-review-comments.md`

## Verification

- Parse the workflow YAML with a parser that preserves the `on` key correctly.
- Run the focused pull-request review example test.
- Run `pnpm run test:mapping`.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run `git diff --check`.

## Completion criteria

- Workflow-level concurrency is absent.
- Irrelevant comments do not reach the review concurrency group.
- Recognized comments, eligible pull-request updates, and manual dispatches
  remain serialized per pull request and cancel older review jobs.
- Closed pull requests still interrupt active review work without running the
  review or publisher steps.
- The admission and cancellation jobs have no unnecessary permissions.
- Tests and documentation describe the corrected admission boundary.

## Outcome

The workflow now admits review requests before they enter per-pull-request
concurrency. Irrelevant comments finish without affecting active reviews.
Recognized commands intentionally replace older review runs, and a closed pull
request still cancels active review work through a separate no-op job. The
workflow regression test and canonical documentation cover these invariants.

## Traceability

- Contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
