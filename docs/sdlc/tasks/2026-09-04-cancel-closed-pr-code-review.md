---
id: task.cancel-closed-pr-code-review
title: Cancel Active Reviews When Pull Requests Close
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream: []
supersedes: []
---

# Cancel Active Reviews When Pull Requests Close

## Objective

When a pull request closes, its active Seqlane code-review workflow run is
cancelled, and the closed event does not start a new review job.

## Upstream requirements

No upstream SDLC document owns this GitHub Actions workflow behavior. Preserve
the existing review workflow name, concurrency group, and `cancel-in-progress`
setting.

## Scope

- Add the `closed` activity type to the existing `pull_request_target` trigger.
- Keep the code-review job skipped for closed pull requests while preserving
  the existing eligibility conditions for review events.
- Document the event and job invariants in this task and the examples README.

## Out of scope

- Changes to pnpm or Node.js setup.
- Changes to review input, models, reasoning levels, task topology, or report
  behavior.
- Changes to the workflow name or concurrency group.
- Runtime cancellation behavior outside GitHub Actions.

## Implementation plan

1. Add `closed` to the existing `pull_request_target` activity types.
2. Guard the job against closed pull requests while retaining the existing
   draft and same-repository checks.
3. Verify YAML syntax and the concurrency/cancellation invariants.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `examples/README.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Parse the workflow as YAML and inspect the trigger/job expressions.
- Confirm the workflow name, concurrency group, and `cancel-in-progress: true`
  are unchanged.
- Run `git diff --check`.
- No executable YAML test pattern exists in this repository; the task records
  the invariant and uses deterministic YAML inspection instead.

## Completion criteria

- A `closed` `pull_request_target` event is accepted by the workflow.
- The code-review job is skipped for closed events, including closed draft
  pull requests, and existing review-event eligibility remains unchanged.
- The unchanged workflow-level concurrency group and
  `cancel-in-progress: true` allow a closed event to cancel an active run for
  the same pull request.
- No pnpm, model, review-logic, or workflow-name changes are present.
- YAML and repository diff checks pass.

## Outcome

The workflow now accepts the `closed` `pull_request_target` activity. Its
code-review job excludes the `closed` action while preserving the existing
draft and same-repository gates. The unchanged workflow-level concurrency group
and `cancel-in-progress: true` cancel an active review run for the same pull
request when the close event is queued. The examples README documents this
behavior. No executable YAML test pattern exists in the repository, so YAML
parsing and deterministic invariant inspection provide the regression check.

## Traceability

This task intentionally has no upstream SDLC document. It owns the narrow
GitHub Actions trigger and job-gating behavior described above.
