---
id: task.migrate-to-runner-built-action-bundles
title: Migrate to Runner-Built Action Bundles
status: in-progress
owners:
  - core
created: 2026-09-11
updated: 2026-09-11
upstream:
  - adr.runner-built-action-bundles
supersedes: []
---

# Migrate to Runner-Built Action Bundles

## Objective

Remove committed GitHub Action bundles while preserving every local Action
contract, lifecycle, trust boundary, and required CI check.

## Upstream requirements

Implement [adr.runner-built-action-bundles](../adrs/2026-09-11-runner-built-action-bundles.md).

## Scope

- Make all six Action builds atomic and cacheable.
- Materialize required Actions before local `uses:` steps.
- Cache Nx bundle computations across runner jobs.
- Remove tracked bundle output and committed-file drift checks.
- Keep bundle-loading tests and hosted workflow verification.
- Update Action instructions and active specifications.

## Out of scope

- Changing Action inputs, outputs, behavior, or cleanup.
- Replacing Actions with CLIs, composite Actions, or inline workflow code.
- Publishing Actions for external repositories.
- Caching reviewed repository data, Git state, or runtime results.

## Implementation plan

1. Define precise Nx bundle inputs and outputs.
2. Collapse each Action main/post build into one cacheable task.
3. Restore the Nx cache and build required Action groups in each consuming job.
4. Replace bundle-drift CI and hook checks with build and load checks.
5. Remove tracked bundles and ignore `dist` output.
6. Update specifications, instructions, and workflow fixtures.
7. Verify cold builds, cache restoration, affected builds, tests, and workflows.

## Affected areas

- `actions/*/project.json`
- `actions/*/dist/`
- `.github/workflows/`
- `scripts/`
- Action and workflow tests
- Action instructions and SDLC documents

## Verification

- Test mapping and tooling tests.
- Action typechecks, builds, and unit tests.
- Bundle entrypoint and runtime loading tests.
- `actionlint` and workflow contract tests.
- Cold build followed by cached output restoration.
- SDLC indexes, validation, tests, formatting, and `git diff --check`.
- GitHub-hosted branch workflow execution.

## Completion criteria

- No Action bundle is tracked.
- Every local Action is built before `uses:`.
- Unchanged bundle tasks restore `dist` from Nx cache.
- Relevant source, dependency, lockfile, or build changes invalidate the cache.
- Privileged workflows build only trusted source.
- Required CI has no committed-bundle drift gate.
- Existing Action behavior and post cleanup tests pass.

## Outcome

In progress.

## Delivery state

Not delivered on `main`. Record pull-request and hosted-run evidence after
verification.

## Traceability

- [adr.runner-built-action-bundles](../adrs/2026-09-11-runner-built-action-bundles.md)
- [Code-review Action specification](../specs/2026-09-08-direct-runtime-code-review-action.md)
- [Resolver Action specification](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- [OpenCode setup Action specification](../specs/2026-09-08-opencode-tool-setup-action.md)
- [Ripwire Action specification](../specs/2026-09-08-ripwire-server-action.md)
- [zvec-grep Action specification](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
