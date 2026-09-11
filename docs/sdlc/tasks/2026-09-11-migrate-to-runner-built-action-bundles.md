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
  - adr.use-runner-local-nx-cache
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
- Reuse Nx bundle computations within each runner job.
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
3. Build required Action groups in each consuming job.
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
- Repeated bundle tasks in one runner job restore `dist` from Nx cache.
- Relevant source, dependency, lockfile, or build changes invalidate the cache.
- Privileged workflows build only trusted source.
- Required CI has no committed-bundle drift gate.
- Existing Action behavior and post cleanup tests pass.

## Outcome

The implementation branch removes all ten tracked Action entrypoints and the
committed-bundle drift workflow and verifier. The code-review, resolver, and
Ripwire smoke jobs now install trusted dependencies and materialize required
Actions before local invocation. Six Action and four transitive library build
tasks declare cache inputs and outputs.

Local verification built every Action from source. A second build restored all
10 tasks from the local Nx cache. After removal of every generated Action
`dist` directory, Nx restored all six Action outputs without running esbuild.
Scoped typechecks and tests passed for 11 projects and 23 tasks. The test set
included 334 runtime tests, 123 resolver tests, 107 CLI and workflow-contract
tests, 85 Ripwire tests, and all Action entrypoint-loading tests. Tooling tests,
test mapping, SDLC validation, SDLC tests, formatting, and diff checks passed.

GitHub code search found no external `uses: marcolink/seqlane` consumer. Hosted
run `34584861924` passed before the CI consolidation; verification of the
consolidated workflow remains pending.

The follow-up CI audit retained all six Actions because each has an active
internal consumer and a distinct tested contract. Four reusable quality
workflows and the custom Vitest summary reporter were removed. Required checks
now use one checkout, dependency install, and Nx `lint,build,test` graph.
Action builds own their required typecheck. TypeScript library and application
builds no longer repeat the same compilation through a global lint dependency.
The pre-push hook uses the same graph.

Hosted run `34584861924` showed that copying `.nx/cache` between Nx 22 runners
produces unrecognized artifacts without their local metadata. The ineffective
restore steps were removed under `adr.use-runner-local-nx-cache`. A supported
remote Nx cache remains deferred.

## Delivery state

Not delivered on `main`. The implementation is under review in
[pull request 98](https://github.com/marcolink/seqlane/pull/98).

## Traceability

- [adr.runner-built-action-bundles](../adrs/2026-09-11-runner-built-action-bundles.md)
- [adr.use-runner-local-nx-cache](../adrs/2026-09-11-use-runner-local-nx-cache.md)
- [Code-review Action specification](../specs/2026-09-08-direct-runtime-code-review-action.md)
- [Resolver Action specification](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- [OpenCode setup Action specification](../specs/2026-09-08-opencode-tool-setup-action.md)
- [Ripwire Action specification](../specs/2026-09-08-ripwire-server-action.md)
- [zvec-grep Action specification](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
