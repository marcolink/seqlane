# TS-009 — Built-in Workflow Distribution

**Status:** Superseded

This implemented specification describes the removed built-in package and CLI
catalog. Maintained runnable examples now live in the top-level `examples/`
directory and the CLI loads local workflow files directly.

**Implements:** ADR-009
**Depends on:** TS-008
**Scope:** Built-in workflow package, catalog, distribution, and boundary tests

## 1. Objective

Store workflows shipped with Seqlane in a dedicated compiled package instead
of the test-only fixture package. Make those workflows discoverable as an
explicit `builtin` scope and ship them with the CLI without exposing executor-
specific authoring details.

The first migrated workflow is the minimal two-task example used for local
smoke testing.

```text
@seqlane/builtins
        ↓
builtin catalog
        ↓
CLI workflow reference
        ↓
generic Seqlane Plan
        ↓
private runtime binding
```

## 2. Normative Invariants

- `@seqlane/fixtures` remains private test support only.
- Shipped workflows live in `libs/seqlane-builtins` and package as
  `@seqlane/builtins`.
- The built-ins package publishes compiled JavaScript, declarations, and an
  explicit exports map. Consumers do not import source or `dist` paths.
- Built-in workflow modules use only generic Seqlane authoring contracts and
  declared authoring dependencies.
- Built-in source and Plans contain no OpenCode, Mastra, provider, model,
  session, tool, permission, credential, endpoint, or executor selector.
- Built-in discovery has explicit `builtin` provenance and cannot silently
  shadow repository- or user-scoped workflows.
- Catalog entries resolve to package exports and use the same workflow
  reference and runner loading path as other workflows.
- The CLI distribution depends on the built-ins package and includes its
  compiled artifacts.
- Built-ins initially release in lockstep with the CLI/Seqlane workspace.
- No runtime registry download, package manager, or remote catalog is added.

## 3. Package and Export Contract

Create this workspace package:

```text
libs/seqlane-builtins/
  package.json
  project.json
  tsconfig.json
  src/
    catalog.ts
    example-workflow.ts
```

The package name is `@seqlane/builtins`. Its exports map exposes
named workflow modules and the catalog through package subpaths:

```text
@seqlane/builtins/example-workflow
@seqlane/builtins/catalog
```

The package remains private until independent bundle distribution is designed.
The CLI and future Seqlane entrypoints consume it through a declared
workspace dependency.

## 4. Catalog and Discovery Contract

The built-ins package owns a static catalog. A catalog entry contains enough
information to display and resolve a workflow without importing arbitrary
source:

```ts
interface BuiltinWorkflowDescriptor {
  readonly name: string
  readonly moduleSpecifier: string
  readonly exportName: string
  readonly description: string
}
```

The catalog uses stable names and package module specifiers. The discovery
layer presents the scope-qualified name `builtin:<name>`. It must report
duplicate builtin names as an error and must not silently prefer a builtin over
a repository or user workflow with the same unqualified name.

Execution resolves the selected descriptor to the existing
`<module>#<export>` workflow reference. The loader validates the resulting
workflow using the existing Plan and task-definition checks.

## 5. Distribution and Build Contract

- Nx builds the built-ins package before consumers that execute or discover it.
- The package `files` list includes only distributable compiled artifacts.
- The CLI manifest declares `@seqlane/builtins` as a dependency.
- Workspace lockfile changes are required when package manifests change.
- A packaged installation can resolve a builtin through its public package
  export without a repository-relative import.
- Built-in workflow execution uses the operator-selected generic runtime
  profile; the package does not define provider or model configuration.

## 6. Required Tests

Tests must prove:

- the migrated example workflow builds a two-node generic Plan;
- the fixtures package no longer exports or owns the shipped example;
- every catalog descriptor points to an explicit package module export;
- duplicate builtin names fail deterministically;
- builtin discovery preserves `builtin` provenance and collision behavior;
- the CLI resolves a builtin through the same runner boundary as a module
  reference;
- package exports resolve after build and do not use relative source or
  `dist` imports across package boundaries;
- static boundary checks reject executor-specific terms in built-in source;
- the built-in package and CLI pass typecheck, tests, build, lint, formatting,
  and Nx synchronization checks.

## 7. Explicitly Deferred

TS-009 does not implement:

- independent versioning or publishing of reusable workflow bundles;
- remote catalogs, runtime package installation, or a central registry;
- user or repository workflow precedence changes beyond explicit builtin scope;
- workflow-level provider, model, executor, tool, or permission selection;
- a general plugin API for third-party built-in packages;
- a new Plan or runner protocol shape.

## 8. Delivery Order

1. Bootstrap `@seqlane/builtins` and move the example workflow out
   of fixtures.
2. Add the static builtin catalog and explicit discovery scope.
3. Ship the package through the CLI build and dependency graph.
4. Add boundary, packaging, discovery, CLI, and documentation verification.

## 9. Acceptance Criteria

TS-009 is complete when:

- the example workflow is stored and exported by `@seqlane/builtins`;
- `@seqlane/fixtures` contains only test fixtures;
- builtins are listed and resolved with `builtin:<name>` provenance;
- the CLI distribution includes compiled builtins and executes one through the
  existing runner boundary;
- no built-in source or Plan leaks executor-specific configuration;
- lockstep package/build behavior and collision rules are covered by tests;
- all workspace quality gates pass.
