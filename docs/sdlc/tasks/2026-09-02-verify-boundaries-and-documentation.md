---
id: task.verify-boundaries-and-documentation
title: Verify boundaries and document built-in workflows
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.builtin-workflow-distribution
supersedes: []
---

# Verify boundaries and document built-in workflows

> Migrated from implementation story `TS-009-03`.

## Use Case

**As a** Seqlane maintainer, **I want to** protect the built-in package
boundary and document its usage, **so that** future workflows remain shippable
and executor-neutral.

## Scope

- Add package export, catalog, discovery, and CLI boundary tests.
- Add checks that reject executor-specific authoring terms in built-in source.
- Verify fixtures remain private test support.
- Document built-in workflow references and the local execution command.
- Update the architecture index and nearby mutable workflow documentation.

## Out of Scope

- Rewriting accepted ADRs.
- New built-in workflow behavior beyond the migrated example.
- Public third-party workflow bundle documentation.

## Implementation Notes

Tests should inspect public package exports and source boundaries, not private
adapter implementation details. Documentation must show generic workflow
authoring and a generic runtime profile. Keep provider and credential setup in
runtime-specific documentation only.

## Acceptance Criteria

**Scenario:** *Boundary checks protect shipped workflows*
- **Given:** Built-in source, Plans, package exports, and catalog entries
- **When:** boundary tests run
- **Then:** executor-specific authoring fields and imports fail validation

**Scenario:** *Fixtures cannot become a shipping dependency*
- **Given:** CLI and package manifests
- **When:** dependency and export checks run
- **Then:** shipped packages do not depend on `seqlane-fixtures`

**Scenario:** *Operators can find the run command*
- **Given:** The built-in workflow documentation
- **When:** An operator follows the example
- **Then:** it identifies the builtin reference, required input, and generic
  runtime option without requiring a repository-relative module path

**Scenario:** *Workspace quality gates remain green*
- **Given:** The completed spec.builtin-workflow-distribution implementation
- **When:** typecheck, tests, lint, build, format, Nx sync, and diff checks run
- **Then:** all gates pass

## Source

- [adr.builtin-workflow-distribution — Store and Ship Built-in Workflows as a Dedicated Package](../adrs/2026-09-02-builtin-workflow-distribution.md)
- [adr.repository-user-workflow-discovery-and-composition — Support Repository and User Scoped Composition](../adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md)
- [adr.executor-neutral-workflow-authoring — Keep Workflow Authoring and Plans Executor-Neutral](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.builtin-workflow-distribution — Built-in Workflow Distribution](../specs/2026-09-02-builtin-workflow-distribution.md)

## Traceability

- [spec.builtin-workflow-distribution](../specs/2026-09-02-builtin-workflow-distribution.md)
