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

Move the OpenCode and zvec-grep service Actions into the Nx workspace in two
phases while preserving their public contracts and runtime behavior. First
ship the additive workspace Actions. Then adopt them in the review workflow
and delete the obsolete legacy Action trees.

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
  identity, and safe process-group termination only.
- Keep filesystem checks and OpenCode/zvec-grep readiness helpers in their
  respective Action packages.
- Ship committed `dist/main.js` and `dist/post.js` bundles plus the separate
  process-anchor asset for each Action.
- Preserve all legacy Action inputs and outputs.
- Adopt the workspace Actions in `.github/workflows/seqlane-code-review.yml`
  and remove the obsolete `.github/actions` lifecycle trees.
- Add focused tests, Nx targets, package exports, and workspace lockfile
  updates.
- Update this task and generated indexes after verification.

## Out of scope

- Conflict-resolver reuse or changes to Seqlane runtime contracts.
- A generic GitHub Action support library.
- Rewriting accepted ADRs or historical completed task records.

## Implementation plan

1. Extract state-neutral process supervision, dual process identities, and
   safe group termination into the private workspace library.
2. Keep filesystem and service-specific readiness behavior in each Action;
   add thin adapters with post entrypoints.
3. Add action metadata, package manifests, Nx targets, tests, bundles, and
   process-anchor assets.
4. Adopt the workspace Action paths in the review workflow and delete the
   obsolete legacy lifecycle trees.
5. Update workspace dependency and SDLC indexes.
6. Run focused typechecks, tests, bundle-drift, mapping, and documentation
   checks, then record the outcome.

## Affected areas

- `actions/opencode-server/`
- `actions/zvec-grep-server/`
- `libs/action-service-lifecycle/`
- `.github/workflows/seqlane-code-review.yml`
- `.github/actions/lib/`
- `.github/actions/opencode-server/`
- `.github/actions/zvec-grep-server/`
- `package.json`
- `pnpm-lock.yaml`
- `docs/sdlc/tasks/`

## Verification

- Typecheck the lifecycle library and both Actions.
- Run lifecycle, OpenCode readiness, and zvec-grep readiness tests, including
  leader-loss cleanup through the independent in-group verifier.
- Build both `main.js` and `post.js` bundles and verify bundle drift.
- Parse workflow and Action metadata YAML; run `actionlint` when available.
- Run `pnpm test:mapping`, `pnpm docs:index`, and `pnpm docs:validate`.
- Run formatting and `git diff --check`; confirm no live legacy Action path
  references remain except historical documentation.

## Completion criteria

- Both workspace Actions expose the legacy input/output contracts.
- Both Actions start and clean up their process groups through the new
  state-neutral library and post handlers, including cleanup after anchor
  loss without unsafe PID/PGID reuse.
- The shared library owns only process supervision, identity, and termination;
  each Action owns its filesystem and readiness helpers.
- Bundles and process-anchor assets are committed artifacts.
- The review workflow uses the workspace Action paths and obsolete legacy
  lifecycle trees are deleted.
- Focused checks and SDLC checks pass.

## Outcome

Added Nx OpenCode and zvec-grep JavaScript Actions with legacy-compatible
metadata, committed main/post bundle outputs, and separately shipped process
anchors. The anchors now start independent in-group verifiers; termination
validates either recorded member before graceful and forceful signals, so a
dead anchor does not prevent safe descendant cleanup. The shared
`@seqlane/action-service-lifecycle` package now owns only process supervision,
identity, and termination; filesystem and readiness helpers live in the
owning Actions. The review workflow now uses the workspace Action paths and
the obsolete `.github/actions` lifecycle trees are deleted. Focused lifecycle,
readiness, typecheck, lint, bundle, mapping, documentation, and formatting
checks passed; `actionlint` was unavailable in the environment.

## Traceability

- Upstream: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
