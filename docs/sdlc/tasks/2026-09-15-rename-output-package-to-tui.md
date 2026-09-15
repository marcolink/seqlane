---
id: task.rename-output-package-to-tui
title: Rename the Output Package to TUI
status: planned
owners:
  - core
created: 2026-09-15
updated: 2026-09-15
upstream:
  - spec.run-terminal-rendering
  - task.separate-run-machine-output
supersedes: []
---

# Rename the Output Package to TUI

## Objective

Replace `@seqlane/output` with the narrow `@seqlane/tui` terminal-presentation
package. Keep the existing human and CI behavior during this migration.

## Upstream requirements

- [requirement-terminal-package-boundary](../specs/2026-09-15-run-terminal-rendering.md#requirement-terminal-package-boundary)
- [requirement-renderer-contract](../specs/2026-09-15-run-terminal-rendering.md#requirement-renderer-contract)
- [requirement-run-projection](../specs/2026-09-15-run-terminal-rendering.md#requirement-run-projection)

## Scope

- Move `libs/output` to `libs/tui`.
- Rename the package, Nx project, paths, dependencies, fixtures, and tests.
- Replace `@seqlane/output` imports with `@seqlane/tui` imports.
- Rename human-specific shared model types to neutral run-projection types.
- Narrow package exports to one factory and its consumer contracts.
- Keep concrete renderers, components, and model internals private.
- Keep the human and CI renderer behavior stable in this task.
- Remove stale package names and documentation references.

## Out of scope

- A compatibility package or duplicate export path.
- Ink components and keyboard input.
- Runtime, protocol, or execution-event changes.

## Implementation plan

1. Move the project and update workspace configuration.
2. Rename the package and all declared imports.
3. Rename shared model types and separate presentation state.
4. Narrow exports and update boundary tests.
5. Rebuild the lockfile and remove all stale paths.

## Affected areas

- `libs/output`, which becomes `libs/tui`.
- `apps/cli` package dependencies and renderer adapter.
- Root TypeScript, Vitest, Nx, and pnpm configuration.
- Package README files and SDLC references.

## Verification

Run the test-mapping check first. Build and typecheck the TUI and CLI projects.
Run all migrated renderer and CLI tests. Search the workspace for stale
`@seqlane/output` and `libs/output` references.

Make sure that core, protocol, and runtime do not depend on terminal packages.
Make sure that package consumers use declared exports only.

## Completion criteria

- `libs/tui` and `@seqlane/tui` are the only package names.
- The old package, import path, and project name do not remain.
- Human and CI behavior stays equivalent.
- Shared projection types use presentation-neutral names.
- The package root exposes one coherent renderer API.

## Outcome

Not delivered.

## Delivery state

Planned. This task starts after `task.separate-run-machine-output`.

## Traceability

- [spec.run-terminal-rendering: Run Terminal Rendering and Final Results](../specs/2026-09-15-run-terminal-rendering.md)
- [task.separate-run-machine-output: Separate Final Run Results from Event Output](./2026-09-15-separate-run-machine-output.md)
