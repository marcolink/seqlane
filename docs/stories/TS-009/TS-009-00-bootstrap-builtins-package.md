# TS-009-00 — Bootstrap the built-ins package and migrate the example

**Status:** completed

## Use Case

**As a** Seqlane maintainer, **I want to** store shipped workflows in a
dedicated package, **so that** test fixtures do not become product runtime
dependencies.

## Scope

- Create `libs/seqlane-builtins` as `@seqlane/builtins`.
- Add Nx project, TypeScript build, package metadata, and explicit exports.
- Move the minimal two-task example workflow and its contract test from
  `seqlane-fixtures`.
- Remove the moved workflow from the fixtures package and its exports.

## Out of Scope

- Built-in catalog and discovery resolution.
- CLI dependency wiring or runtime execution changes.
- Independent publishing or versioning.

## Implementation Notes

Use package exports for the workflow module. Keep the workflow generic and
retain its existing two sequential agent tasks and typed input/output contract.
Use declared package dependencies; do not reference another package's source
or `dist` path.

## Acceptance Criteria

**Scenario:** *The built-ins package builds*
- **Given:** The new workspace package
- **When:** Nx builds `seqlane-builtins`
- **Then:** It emits JavaScript and declarations under its own `dist` directory

**Scenario:** *The example is a shipped workflow*
- **Given:** The built-ins package is built
- **When:** A consumer imports `@seqlane/builtins/example-workflow`
- **Then:** It can resolve the exported `exampleWorkflow` value through the
  package exports map

**Scenario:** *Fixtures remain test-only*
- **Given:** The fixture package manifest and source
- **When:** They are inspected
- **Then:** They contain no export or implementation of the shipped example

**Scenario:** *The workflow remains executor-neutral*
- **Given:** The migrated example source
- **When:** Its imports and Plan are inspected
- **Then:** They contain only generic Seqlane authoring contracts and no
  executor-specific configuration

## Source

- [ADR-009 — Store and Ship Built-in Workflows as a Dedicated Package](../../ADR-009-builtin-workflow-distribution.md)
- [ADR-006 — Support Repository and User Scoped Composition](../../ADR-006-repository-user-workflow-discovery-and-composition.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-009 — Built-in Workflow Distribution](../../TS-009-builtin-workflow-distribution.md)
