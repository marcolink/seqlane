---
id: task.require-explicit-opencode-server-executable
title: Require an Explicit OpenCode Server Executable
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.opencode-tool-setup-action
supersedes: []
---

# Require an Explicit OpenCode Server Executable

## Objective

Make the `actions/opencode-server` Action require an explicit executable path.
Preserve its existing startup, readiness, state, logging, and cleanup behavior.

## Upstream requirements

Implement the Server Action contract in
[spec.opencode-tool-setup-action](../specs/2026-09-08-opencode-tool-setup-action.md).

## Scope

- Make `executable` required in `actions/opencode-server/action.yml`.
- Remove the current default value for `executable`.
- Update input parsing to reject a missing executable value.
- Update focused input and lifecycle tests for the required input.
- Update `actions/opencode-server/README.md` with the explicit input contract.
- Rebuild and commit the Server Action bundle.

## Out of scope

- OpenCode installation, version resolution, release download, or caching.
- Changes to `actions/setup-opencode`.
- Review workflow migration. See
  [task.adopt-opencode-tool-setup-in-review-workflow](./2026-09-08-adopt-opencode-tool-setup-in-review-workflow.md).
- Changes to OpenCode configuration, credentials, or review behavior.
- Changes to server startup, readiness, state, logging, or cleanup semantics.

## Implementation plan

1. Add a failing test for a missing `executable` input.
2. Make the Action metadata declare `executable` as required with no default.
3. Update the input adapter and tests while preserving lifecycle behavior.
4. Update the Action README with the required executable contract.
5. Rebuild the committed bundle and run focused Action checks.

## Affected areas

- `actions/opencode-server/action.yml`
- `actions/opencode-server/src/main.ts`
- `actions/opencode-server/src/main.spec.ts`
- `actions/opencode-server/README.md`
- `actions/opencode-server/dist/main.js`

## Verification

Run the Server Action input and lifecycle tests. Prove that a missing
`executable` input fails before process startup.

Parse the Action metadata as YAML. Run the Action typecheck, build,
bundle-load, bundle-drift, and `pnpm test:mapping` checks.

Run `actionlint` when it is available. Run `pnpm docs:index`,
`pnpm docs:validate`, and `git diff --check`.

## Completion criteria

- `executable` is required and has no default in the Action metadata.
- Missing executable input fails before process startup.
- An explicit executable path reaches the existing lifecycle code unchanged.
- The README documents the required executable input.
- The committed bundle has no drift.
- Focused tests, bundle checks, repository checks, and SDLC checks pass.

## Outcome

This task is planned. The Server Action still accepts its current default
executable until this task is complete.

## Traceability

- [spec.opencode-tool-setup-action](../specs/2026-09-08-opencode-tool-setup-action.md)
- [task.add-opencode-tool-setup-action](./2026-09-08-add-opencode-tool-setup-action.md)
- [task.adopt-opencode-tool-setup-in-review-workflow](./2026-09-08-adopt-opencode-tool-setup-in-review-workflow.md)
