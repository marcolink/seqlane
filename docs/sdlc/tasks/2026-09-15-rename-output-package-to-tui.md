---
id: task.rename-output-package-to-tui
title: Rename the Output Package to TUI
status: completed
owners:
  - core
created: 2026-09-15
updated: 2026-09-16
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

- `libs/tui`, formerly `libs/output`.
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

Renamed the private terminal package from `@seqlane/output` to
`@seqlane/tui`, including the `libs/tui` project path, workspace references,
package metadata, lockfile importer, and CLI imports. Renamed the shared
human-specific projection types to neutral run-view-model types and kept the
concrete renderers and projection internals private behind the package-root
renderer factory. The migrated human and CI renderer tests and the CLI output
contract tests remain in the new package paths.

`pnpm test:mapping` passes with 286 mappings. The TUI suite passes with 64
tests. The CLI suite passes with 133 tests. The compiled CLI suite passes with
37 tests. TUI and CLI typechecks pass.

## Delivery state

Delivered to the default branch through [pull request
#118](https://github.com/marcolink/seqlane/pull/118).

## Traceability

- [spec.run-terminal-rendering: Run Terminal Rendering](../specs/2026-09-15-run-terminal-rendering.md)
- [task.separate-run-machine-output: Separate Final Run Results from Event Output](./2026-09-15-separate-run-machine-output.md)
