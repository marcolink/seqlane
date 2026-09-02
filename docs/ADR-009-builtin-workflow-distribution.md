# ADR-009 — Store and Ship Built-in Workflows as a Dedicated Package

**Status:** Implemented
**Scope:** Built-in workflow storage, packaging, and discovery
**Related:** ADR-006, ADR-008, MVP

## Context

Seqlane needs workflows that are shipped with the Seqlane distribution and
available without repository-local authoring. These built-in workflows are
product capabilities, not test fixtures.

The current `@seqlane/fixtures` package is private test support. It
contains deterministic fixtures and contract tests, and must not become the
distribution mechanism for executable built-in workflows.

Built-ins must remain compatible with the executor-neutral authoring boundary
from ADR-008. Their source must not select OpenCode, a provider, a model, a
session, or another executor implementation.

## Decision Outcome

Store built-in workflows in a dedicated workspace package:

```text
libs/seqlane-builtins/
  package.json                 # @seqlane/builtins
  src/<workflow>.ts
  src/catalog.ts
```

The package will:

- export compiled workflow modules through an explicit `package.json` exports
  map;
- expose built-in metadata through a package-owned catalog for discovery;
- depend on `@seqlane/core` and other declared authoring
  dependencies only;
- contain ordinary TypeScript workflow definitions, not a new workflow module
  system;
- be a dependency of the shipped CLI/distribution and be included in its
  installable artifact;
- use a distinct discovery scope, such as `builtin:<name>`, so built-ins do
  not silently collide with repository or user workflows;
- resolve execution through the existing generic workflow reference and
  private runtime bindings.

Built-ins are initially versioned and released in lockstep with the Seqlane
CLI. A separately published reusable workflow bundle is deferred.

## Decision Drivers

- Keep test fixtures separate from shipped product behavior.
- Preserve normal TypeScript and npm package semantics.
- Keep built-ins portable across executor implementations.
- Make discovery provenance and name collisions explicit.
- Ship compiled JavaScript and declarations, not repository source files.
- Avoid introducing a central service or runtime download dependency.

## Options Considered

### Keep built-ins in `seqlane-fixtures`

Rejected. Test fixtures have test-oriented ownership, deterministic behavior,
and package boundaries. Using them for product workflows would couple release
behavior to test support and encourage accidental fixture dependencies.

### Put built-ins directly in the CLI package

Rejected. This makes the CLI own workflow authoring code, reduces reuse by
other Seqlane entrypoints, and mixes command supervision with workflow
capabilities.

### Use a dedicated built-ins package

Chosen. This gives built-in workflows an explicit package boundary while
allowing the CLI and future products to consume the same compiled modules.

### Download built-ins from a registry at runtime

Deferred. A registry adds availability, trust, version, and compatibility
requirements that are not needed for the initial shipped set.

## Consequences

### Positive

- Built-ins have a clear production ownership boundary.
- Fixtures remain free to change for tests without changing shipped behavior.
- The CLI can discover built-ins from a stable package catalog.
- Explicit `builtin` provenance prevents silent repository/user shadowing.
- Compiled package exports work across the existing runner process boundary.
- Future built-in consumers do not need to depend on the private fixture package.

### Negative

- A new package and catalog must be maintained.
- The CLI distribution must keep the built-ins package dependency synchronized.
- Built-in compatibility is coupled to the Seqlane release until independent
  bundle versioning is designed.
- Discovery must define collision and qualification rules across three scopes.

## Follow-Up Constraints

- Move the minimal example workflow out of `@seqlane/fixtures`
  before treating it as a shipped built-in.
- Add `libs/seqlane-builtins` with explicit exports and compiled output.
- Add catalog and CLI discovery tests for the `builtin` scope.
- Keep built-in workflow source free of executor-specific authoring concepts.
- Keep fixtures private and test-oriented.
- Update ADR-006's implementation when built-in discovery is delivered; do not
  silently change its repository/user ambiguity rules.
- Document the built-in package and copy-paste execution path near the CLI
  usage documentation.

## Revisit Conditions

Revisit this decision when built-ins need independent release cadence, third-
party distribution, signed capability bundles, runtime installation, or
cross-version compatibility beyond the Seqlane CLI release.
