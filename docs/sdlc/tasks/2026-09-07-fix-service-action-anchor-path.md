---
id: task.fix-service-action-anchor-path
title: Fix Service Action Anchor Path Resolution
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - adr.seqlane-action-library-boundary
supersedes: []
---

# Fix Service Action Anchor Path Resolution

## Objective

Restore the trusted pull-request review workflow by resolving each service
Action's shipped process-anchor asset without an unavailable runner variable.

## Upstream requirements

- Keep service Action assets packaged with their owning Action.
- Preserve the review workflow trust boundary and existing Action contracts.

## Scope

- Correct process-anchor asset resolution for the zvec-grep and OpenCode
  service Actions.
- Add a regression test for the Action runtime environment.
- Rebuild and verify both Action bundles.

## Out of scope

- Changes to workflow permissions, review policy, service configuration, or
  public Action inputs and outputs.

## Implementation plan

1. Reproduce the missing-action-path environment in focused Action tests.
2. Resolve the shipped anchor relative to the bundled module instead.
3. Verify both Actions, bundles, mapping, and workflow syntax.

## Affected areas

- `actions/zvec-grep-server/`
- `actions/opencode-server/`
- `docs/sdlc/tasks/`

## Verification

- Run focused Action tests, typechecks, builds, and bundle-drift targets.
- Run `pnpm test:mapping`, `pnpm docs:index`, and `pnpm docs:validate`.
- Run `actionlint` when available.

## Completion criteria

- Both Actions start with `GITHUB_ACTION_PATH` absent.
- Both Actions retain their existing public metadata and cleanup behavior.
- Committed bundles match source.

## Outcome

Resolved anchor assets relative to each bundled ESM Action module, so startup
does not depend on `GITHUB_ACTION_PATH`. Added source and bundle regression
coverage with that variable absent; focused Action tests, typechecks, and
bundle-drift checks passed.

Delivered in [PR #70](https://github.com/marcolink/seqlane/pull/70).

## Traceability

- Upstream: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
