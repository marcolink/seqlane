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

- Publish one immutable audit comment for each completed run.
- Migrate legacy single-`run` and append-only `runs` v3 state on the next publication.
- Keep the authoritative state bounded with only the latest run and summary.
- Keep every run's metrics in a JSON array in the human projection.
- Render cumulative pull-request cost and latest-run cost from retained history.
- Re-read the trusted report before publication and skip stale concurrent writes.
- Reject ambiguous states containing both `run` and `runs`.
- Add regression coverage for history validation and metadata identity.

## Out of scope

- Changing provider pricing or token accounting.
- Dropping historical run metrics from the immutable audit comments.
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
- Every run's plain JSON metrics remain available to reviewers as one list.

## Outcome

The workflow now stores each completed run in an immutable audit comment,
migrates prior state history, keeps the authoritative state bounded, guards
against stale concurrent publication, and rejects ambiguous run fields. The
human projection shows cumulative pull-request cost and latest-run cost while
retaining every run's plain JSON metrics in one list.

## Traceability

- Contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Prior delivery: [task.review-progress-and-run-metrics](./2026-09-05-review-progress-and-run-metrics.md)
