---
id: task.migrate-service-actions-to-workspace-structure
title: Migrate Service Actions to the Workspace Structure
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - adr.seqlane-action-library-boundary
supersedes: []
---

# Migrate Service Actions to the Workspace Structure

## Objective

Move the OpenCode and zvec-grep service Actions into the Nx workspace while
preserving their existing public contracts and runtime behavior. Keep the
legacy `.github/actions` implementations and workflow untouched during this
additive migration.

## Upstream requirements

- The Action boundary remains separate from Seqlane application packages.
- Action entrypoints adapt GitHub Actions inputs, outputs, state, and failure
  handling.
- Reusable service lifecycle behavior belongs in a private Action library and
  must not depend on `@actions/core`.
- The accepted [Action library boundary ADR](../adrs/2026-09-06-seqlane-action-library-boundary.md)
  remains unchanged.

## Scope

- Add Nx JavaScript Actions under `actions/opencode-server` and
  `actions/zvec-grep-server`.
- Add `libs/action-service-lifecycle` for process supervision, process
  identity, cleanup, and readiness primitives.
- Ship committed `dist/main.js` and `dist/post.js` bundles plus the separate
  process-anchor asset for each Action.
- Preserve all legacy Action inputs and outputs.
- Add focused tests, Nx targets, package exports, and workspace lockfile
  updates.
- Update this task and generated indexes after verification.

## Out of scope

- Deleting or changing `.github/actions`.
- Changing existing workflows.
- Conflict-resolver reuse or changes to Seqlane runtime contracts.
- A generic GitHub Action support library.

## Implementation plan

1. Extract state-neutral lifecycle primitives into the private workspace
   library.
2. Add thin OpenCode and zvec-grep Action adapters with post entrypoints.
3. Add action metadata, package manifests, Nx targets, tests, bundles, and
   process-anchor assets.
4. Update workspace dependency and SDLC indexes.
5. Run focused typechecks, tests, bundle-drift, mapping, and documentation
   checks, then record the outcome.

## Affected areas

- `actions/opencode-server/`
- `actions/zvec-grep-server/`
- `libs/action-service-lifecycle/`
- `package.json`
- `pnpm-lock.yaml`
- `docs/sdlc/tasks/`

## Verification

- Typecheck the lifecycle library and both Actions.
- Run lifecycle and readiness tests.
- Build both `main.js` and `post.js` bundles and verify bundle drift.
- Run `pnpm test:mapping`, `pnpm docs:index`, and `pnpm docs:validate`.
- Run `git diff --check` and confirm the legacy Actions and workflow are
  unchanged.

## Completion criteria

- Both workspace Actions expose the legacy input/output contracts.
- Both Actions start and clean up their process groups through the new
  state-neutral library and post handlers.
- Bundles and process-anchor assets are committed artifacts.
- No legacy Action or workflow file changes are introduced.
- Focused checks and SDLC checks pass.

## Outcome

Added Nx OpenCode and zvec-grep JavaScript Actions with legacy-compatible
metadata, committed main/post bundle outputs, and separately shipped process
anchors. Added the Toolkit-free `@seqlane/action-service-lifecycle` package
for process supervision, identity validation, cleanup, and readiness. Legacy
`.github/actions` and the review workflow remain unchanged. Focused typechecks,
tests, bundle-drift targets, test mapping, SDLC indexing, SDLC validation, and
diff checks passed.

## Traceability

- Upstream: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
