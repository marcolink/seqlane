---
id: task.preserve-pull-request-review-run-history
title: Preserve Pull Request Review Run History
status: completed
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Preserve Pull Request Review Run History

## Objective

Retain every completed review run's metrics in the authoritative pull-request
comment and show both cumulative pull-request cost and latest-run cost.

## Upstream requirements

Implement [requirement-run-status-and-metrics](../specs/2026-09-05-versioned-pull-request-review-comments.md#requirement-run-status-and-metrics).

## Scope

- Replace the single new-state run record with append-only `runs` history.
- Read legacy single-`run` v3 state and migrate it on the next publication.
- Keep the latest run metrics JSON block in the human projection.
- Render cumulative pull-request cost and latest-run cost from retained history.
- Add regression coverage for history validation and metadata identity.

## Out of scope

- Changing provider pricing or token accounting.
- Dropping historical run metrics to fit a smaller state bound.
- Changing review finding lifecycle behavior.

## Implementation plan

1. Extend the review state schema with compatible run history.
2. Carry prior history through the local publisher output.
3. Append the current run and render both cost values in the workflow.
4. Update documentation and run focused repository checks.

## Affected areas

- `examples/pr-code-review.ts`
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`
- `.github/workflows/seqlane-code-review.yml`
- `examples/README.md`
- `docs/sdlc/specs`

## Verification

- Validate legacy and appended v3 state with focused review tests.
- Inspect the workflow jq state merge and cost aggregation.
- Run `pnpm run test:mapping` and the focused pull-request review tests.
- Run `pnpm docs:index` and `pnpm docs:validate`.

## Completion criteria

- Consecutive publications retain every prior run audit record.
- Legacy single-run state is not discarded during migration.
- The comment shows absolute pull-request cost and latest-run cost.
- The latest run's plain JSON metrics remain available to reviewers.

## Outcome

The review state now preserves append-only run audit history and migrates the
legacy single-run shape when a new report is published. The human projection
shows cumulative pull-request cost and latest-run cost while retaining the
latest run's plain JSON metrics.

## Traceability

- Contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Prior delivery: [task.review-progress-and-run-metrics](./2026-09-05-review-progress-and-run-metrics.md)
