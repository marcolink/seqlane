# TS-009-01 — Add the built-in catalog and discovery scope

**Status:** completed

## Use Case

**As a** Seqlane operator, **I want to** identify built-in workflows by
explicit scope, **so that** shipped capabilities do not silently collide with
repository or user workflows.

## Scope

- Add the package-owned static built-in catalog.
- Define descriptor validation and stable builtin names.
- Encode `builtin:<name>` provenance in catalog descriptors.
- Resolve qualified builtin names to module/export descriptors without importing
  workflow source.
- Reject duplicate builtin names and malformed package references.

## Out of Scope

- Remote catalogs or dynamic package installation.
- Repository/user discovery and cross-scope collision handling.
- Workflow execution semantics or new runner protocol fields.

## Implementation Notes

Catalog metadata must be serializable and must not import workflow source just
to list names. Resolution must use explicit package exports and the existing
workflow loader. Keep discovery separate from normal TypeScript composition.

## Acceptance Criteria

**Scenario:** *The catalog lists built-ins*
- **Given:** A built-in package catalog
- **When:** Discovery reads the catalog
- **Then:** It returns stable names, descriptions, module specifiers, and export
  names with `builtin` provenance

**Scenario:** *A qualified builtin name resolves to metadata*
- **Given:** `builtin:example` is present in the catalog
- **When:** Discovery resolves the qualified name
- **Then:** It returns the package module specifier and export name without
  importing the workflow module

**Scenario:** *Duplicate builtin names fail*
- **Given:** Two catalog entries use the same builtin name
- **When:** The catalog is validated
- **Then:** Discovery fails with a deterministic duplicate-name error

## Source

- [ADR-009 — Store and Ship Built-in Workflows as a Dedicated Package](../../ADR-009-builtin-workflow-distribution.md)
- [ADR-006 — Support Repository and User Scoped Composition](../../ADR-006-repository-user-workflow-discovery-and-composition.md)
- [TS-009 — Built-in Workflow Distribution](../../TS-009-builtin-workflow-distribution.md)
