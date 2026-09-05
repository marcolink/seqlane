---
id: task.review-progress-and-run-metrics
title: Show Review Progress and Persist Run Metrics
status: completed
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream:
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Show Review Progress and Persist Run Metrics

## Objective

Make repeated pull-request reviews observable while they run and preserve
mechanical per-task usage information in the authoritative report.

## Upstream requirements

Implement [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md), especially
`requirement-run-status-and-metrics`.

## Scope

- Mark an existing trusted report with a prominent temporary in-progress note.
- Remove the note after publication and during failure cleanup.
- Aggregate task result states, durations, models, tokens, and costs from the
  serialized execution events without agent work.
- Show the metrics as plain JSON in the comment and store them in v3 run state.
- Validate persisted run metrics with the review-state schema.
- Update workflow, example documentation, and contract tests.

## Out of scope

- Changing model pricing or provider accounting.
- Retaining an unbounded history of all previous run metrics.
- Adding an agent task to interpret or calculate metrics.

## Implementation plan

1. Add the validated run metrics state contract.
2. Add workflow marker and always-run cleanup steps.
3. Derive metrics mechanically from replay events and publish the JSON object.
4. Add focused validation coverage and update documentation.
5. Run repository checks and inspect the workflow definition.

## Affected areas

- `examples/pr-code-review.ts`
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`
- `.github/workflows/seqlane-code-review.yml`
- `examples/README.md`
- `docs/sdlc/specs`
- `docs/sdlc/tasks`

## Verification

- Validate the workflow YAML and metrics jq program with representative events.
- Run `pnpm run test:mapping` and the focused pull-request review tests.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Confirm the comment contains the plain metrics object and cleanup marker
  behavior in the workflow source.

## Completion criteria

- A pre-existing trusted report receives a prominent temporary notice.
- Successful, failed, and cancelled paths remove the notice.
- Each run comment shows task-level cost and available usage metrics.
- The same metrics pass strict v3 state validation.
- Metrics calculation uses only serialized events and shell tooling.

## Outcome

The workflow now marks an existing trusted report with a temporary prominent
in-progress notice and removes it after publication or failure cleanup. It
mechanically derives a validated JSON metrics object from serialized execution
events, shows it in the report, and stores it under the v3 run audit data.

## Traceability

- Contract: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- Source proposal: [Seqlane review template](https://github.com/marcolink/seqlane/issues/45)
- Delivery: [pull request 44](https://github.com/marcolink/seqlane/pull/44)
