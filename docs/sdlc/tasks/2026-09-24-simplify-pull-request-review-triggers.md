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
- Keep manual dispatch and close-event cancellation.
- Remove comment events, command extraction, and command-based finding changes.
- Clear legacy disposition effects when a new review reconciles findings.
- Update tests and current review documentation.

## Out of scope

- Changing review lanes, Git evidence, or publication format.
- Changing CI quality gates or the merge-conflict resolver.

## Implementation plan

1. Combine review admission and execution in one job.
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
- Legacy disposition data does not remain active after a new review.

## Outcome

One review job now admits eligible pull-request events and manual dispatches.
Issue comments no longer trigger reviews. Comment commands no longer change
finding status or severity. Legacy disposition effects are cleared when a new
review reconciles findings.

Local verification passed: `pnpm test:mapping`, the Action library and Action
test targets, Action build and typecheck, and `actionlint` for the workflow.

## Delivery state

Local work only. No target-branch delivery claim.

## Traceability

- Review state: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Action boundary: [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
