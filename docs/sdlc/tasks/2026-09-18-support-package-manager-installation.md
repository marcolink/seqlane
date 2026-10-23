---
id: task.support-package-manager-installation
title: Support npm pnpm and Yarn Installation
status: completed
owners:
  - core
created: 2026-09-18
updated: 2026-10-22
upstream:
  - prd.seqlane-runtime
supersedes: []
---

# Support npm pnpm and Yarn Installation

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Allow users to install the public Seqlane CLI and core package with npm, pnpm,
or Yarn. Show each installation path as a tab in public documentation.

## Upstream requirements

This task changes installation metadata and public documentation only. It does
not change workflow, runtime, or CLI behavior from
[prd.seqlane-runtime](../prd/2026-10-21-seqlane-runtime.md).

## Scope

- Remove the npm, pnpm, and Yarn engine restrictions from public package
  manifests.
- Keep the Node.js requirement for the CLI.
- Add npm, pnpm, and Yarn code groups to the public installation guide.

## Out of scope

- Changing the repository development toolchain from pnpm.
- Publishing packages, changing versions, or changing package contents.
- Workflow, runtime, or CLI behavior changes.

## Implementation plan

1. Inspect the public package manifests and current installation copy.
2. Remove installer-specific engine restrictions from the CLI and core package.
3. Add tabbed commands for npm, pnpm, and Yarn.
4. Build the public site and validate documentation metadata.

## Affected areas

- `apps/cli/package.json`
- `libs/core/package.json`
- `apps/docs/getting-started/`
- `docs/sdlc/tasks/`

## Verification

- Parse the changed package manifests as JSON.
- Build the public VitePress site.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run Prettier for changed files.

## Completion criteria

- Public package metadata does not reject npm or Yarn.
- The installation guide has npm, pnpm, and Yarn tabs.
- The repository continues to use pnpm for development.

## Outcome

Removed installer-specific engine restrictions from the public CLI and core
package manifests. The public installation guide now shows npm, pnpm, and Yarn
tabs for global installation, project installation, and a first `run`.

Checks passed:

- `npm --prefix apps/cli pkg get engines`
- `npm --prefix libs/core pkg get engines`
- `pnpm --dir apps/docs run build`
- `NX_WORKSPACE_DATA_DIRECTORY="$PWD/.nx/workspace-data" NX_DAEMON=false pnpm exec nx build docs-site`
- `pnpm docs:index`
- `pnpm docs:validate`
- `pnpm exec prettier --check` for changed files

## Historical delivery state

Implemented in the current worktree. The change is uncommitted and is not
reachable from the target branch, so it does not establish delivery.

## Traceability

- [prd.seqlane-runtime: Seqlane Runtime Product Requirements](../prd/2026-10-21-seqlane-runtime.md)
- [task.expand-public-documentation-navigation: Expand Public Documentation Navigation](./2026-09-18-expand-public-documentation-navigation.md)
