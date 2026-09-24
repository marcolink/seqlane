---
id: task.simplify-pull-request-review-triggers
title: Simplify Pull Request Review Triggers and Decisions
status: completed
owners:
  - core
created: 2026-09-24
updated: 2026-09-24
upstream:
  - spec.versioned-pull-request-review-comments
  - spec.direct-runtime-code-review-action
  - adr.review-publication-without-comment-commands
supersedes: []
---

# Simplify Pull Request Review Triggers and Decisions

## Objective

Run automatic review in one GitHub job. Stop treating comments as review
commands or finding decisions.

## Upstream requirements

Follow [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md#requirement-workflow-admission-and-concurrency)
and [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md).

## Scope

- Admit eligible same-repository, non-draft PR events in the review job.
- Admit manual dispatch through a read-only live-PR check before review
  concurrency. Keep close-event cancellation.
- Remove comment events, command extraction, and command-based finding changes.
- Publish strict version 4 state and reject old disposition-bearing state
  instead of importing it. Remove decision fields from current finding and
  publication contracts.
- Restore focused current-head lifecycle tests.
- Supersede the obsolete mechanical-writer ADR.
- Update tests and current review documentation.

## Out of scope

- Changing review lanes, Git evidence, or publication format.
- Changing CI quality gates or the merge-conflict resolver.

## Implementation plan

1. Admit automatic PR events in one review job; validate manual dispatch first.
2. Remove command parsing and decisions across the Action and workflow.
3. Reconcile active and planned review documents.
4. Verify the workflow, tests, types, and SDLC documents.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `libs/action-code-review/`
- `workflows/code-review/`
- `docs/sdlc/specs/`
- `workflows/README.md`

## Verification

- Run focused review tests and the test-mapping check.
- Build the Action library and verify types.
- Run `pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.

## Completion criteria

- Automatic and manual reviews use one review job.
- Comments do not trigger reviews or change findings.
- Closed PRs still cancel in-progress review work.
- Old disposition-bearing finding state is rejected and not imported.

## Outcome

One review job admits eligible pull-request events. Manual dispatch passes a
read-only admission job before entering review concurrency. Issue comments no
longer trigger reviews. Current finding contracts reject command decisions and
old state is not imported. Current-head reconciliation tests cover retained
findings and stale verification.

Local verification passed: `pnpm test:mapping`, 76 Action-library tests, 4
Action tests, Action build and typecheck, workflow `actionlint`,
`pnpm docs:index`, and `pnpm docs:validate`.

## Delivery state

PR [#168](https://github.com/marcolink/seqlane/pull/168) is open. No
target-branch delivery claim.

## Traceability

- Review state: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Action boundary: [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
- Architecture: [adr.review-publication-without-comment-commands](../adrs/2026-09-24-review-publication-without-comment-commands.md)
