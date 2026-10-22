---
id: task.bootstrap-core-runtime
title: Bootstrap the core and runtime package boundaries
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Bootstrap the core and runtime package boundaries

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-00`.

## Use Case

**As a** Seqlane maintainer, **I want to** bootstrap the core and runtime package boundaries with private execution dependencies, **so that** runtime work can begin without leaking runtime-engine types into public contracts or adding service infrastructure.

## Acceptance Criteria

**Scenario:** _Core and runtime package boundaries exist_

- **Given:** The repository contains the foundation workspace
- **When:** The package bootstrap is completed
- **Then:** `@seqlane/core` owns public contracts and Plan IR, while `@seqlane/runtime` owns the runner and private execution boundary

**Scenario:** _Required runtime dependencies are installed in the correct package_

- **Given:** The runtime package is created
- **When:** Workspace dependencies are installed
- **Then:** Execution dependencies are available only to `@seqlane/runtime`, `@seqlane/core` has no runtime-engine dependency, and workspace install, typecheck, test, lint, build, and format checks succeed

## Technical Details

The original task established separate authoring and execution packages. The core package remained engine-independent.

Current [contract ownership](../specs/2026-10-21-effect-v4-execution-and-operations.md#requirement-contract-ownership) defines dependency boundaries. This later contract does not describe historical bootstrap delivery.

## Out of Scope

- Implementing the compiler or runner behavior covered by the following stories
- Adding a deployable service, HTTP server, Terraform, or service-kit dependency
- Adding persistence, OpenCode integration, or production deployment configuration

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [rfc.effect-v4-migration: Full Effect v4 Migration](../rfcs/2026-10-21-effect-v4-migration.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
