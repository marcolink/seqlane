---
id: task.built-in-catalog-and-discovery
title: Add the built-in catalog and discovery scope
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.builtin-workflow-distribution
supersedes: []
---

# Add the built-in catalog and discovery scope

> Migrated from implementation story `TS-009-01`.

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

- [adr.builtin-workflow-distribution — Store and Ship Built-in Workflows as a Dedicated Package](../adrs/2026-09-02-builtin-workflow-distribution.md)
- [adr.repository-user-workflow-discovery-and-composition — Support Repository and User Scoped Composition](../adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md)
- [spec.builtin-workflow-distribution — Built-in Workflow Distribution](../specs/2026-09-02-builtin-workflow-distribution.md)

## Traceability

- [spec.builtin-workflow-distribution](../specs/2026-09-02-builtin-workflow-distribution.md)
