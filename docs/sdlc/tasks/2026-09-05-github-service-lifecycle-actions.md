---
id: task.github-service-lifecycle-actions
title: Extract GitHub Actions Service Lifecycles
status: completed
owners:
  - core
created: 2026-09-05
updated: 2026-09-08
upstream: []
supersedes: []
---

# Extract GitHub Actions Service Lifecycles

## Objective

Reduce duplication in GitHub workflows by centralizing the startup,
readiness-check, logging, and cleanup lifecycle for the local OpenCode and
zvec-grep services.

## Upstream requirements

No upstream SDLC document owns this GitHub Actions organization behavior. The
workflow must continue to start local services for the existing pull-request
review use case, and Seqlane must continue to receive the same loopback
endpoints.

## Scope

- Add a local OpenCode lifecycle action with automatic post-job cleanup.
- Add a local zvec-grep lifecycle action with automatic post-job cleanup.
- Share only low-level detached-process and readiness behavior between the
  actions.
- Keep OpenCode installation and version validation in the workflow.
- Keep the zvec-grep indexing command and its file policy in the workflow.
- Update the pull-request review workflow to consume both actions.
- Document the CI lifecycle ownership.

## Out of scope

- Changes to Seqlane runtime or executor behavior.
- Changes to OpenCode or zvec-grep configuration policy.
- Moving the zvec-grep indexing allowlist into an action.
- A generic reusable background-service action.
- Changes to other workflow jobs.

## Implementation plan

1. Add local Node 24 actions with `main` and `post` handlers.
2. Persist process state before readiness polling and clean up process groups
   after the job.
3. Replace the inline OpenCode and zvec-grep lifecycle blocks in the review
   workflow.
4. Verify YAML, JavaScript syntax, readiness helpers, process cleanup, and
   documentation checks.

## Affected areas

- `.github/actions/lib/lifecycle.js`
- `.github/actions/opencode-server/`
- `.github/actions/zvec-grep-server/`
- `.github/workflows/seqlane-code-review.yml`
- `examples/README.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Parse both action metadata files and the review workflow as YAML.
- Run Node syntax checks for all action scripts.
- Exercise detached process-group termination and HTTP/command readiness
  helpers locally.
- Run `git diff --check`.
- Run `pnpm test:mapping`, `pnpm docs:test`, and `pnpm docs:validate`.

## Completion criteria

- The review workflow starts OpenCode and zvec-grep through local actions.
- Both actions clean up their process groups after success, failure, and
  cancellation through post-job handlers.
- The Seqlane runtime URL and zvec-grep MCP URL remain equivalent to the
  previous loopback endpoints.
- OpenCode installation, configuration, and zvec-grep indexing policy remain
  caller-owned.
- No Seqlane package or runtime contract changes are introduced.
- Static and documentation checks pass.

## Outcome

Added local Node 24 lifecycle actions for OpenCode and zvec-grep. The actions
poll the existing readiness contracts, retain run-scoped logs, save process
state before readiness checks, and terminate complete process groups in their
post handlers. The review workflow now consumes the action outputs while
retaining its existing installation, configuration, indexing policy, checkout
layout, and Seqlane execution. Static process and readiness checks passed, as
did the repository test-mapping and documentation checks.

## Traceability

This task intentionally has no upstream SDLC document. It owns the narrow
GitHub Actions service-lifecycle organization described above.
