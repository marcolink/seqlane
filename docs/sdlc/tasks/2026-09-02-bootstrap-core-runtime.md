---
id: task.bootstrap-core-runtime
title: Bootstrap the core and runtime packages for spec.mastra-runtime-integration
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-integration
supersedes: []
---

# Bootstrap the core and runtime packages for spec.mastra-runtime-integration

> Migrated from implementation story `TS-001-00`.

## Use Case
**As a** Seqlane maintainer, **I want to** bootstrap the core and runtime package boundaries with only the dependencies required by spec.mastra-runtime-integration, **so that** runtime work can begin without leaking Mastra into public contracts or adding service infrastructure.

## Acceptance Criteria
**Scenario:** *Core and runtime package boundaries exist*
- **Given:** The repository contains the foundation workspace
- **When:** The spec.mastra-runtime-integration bootstrap is completed
- **Then:** `@seqlane/core` owns public contracts and Plan IR, while `@seqlane/runtime` owns the runner and Mastra integration boundary

**Scenario:** *Required runtime dependencies are installed in the correct package*
- **Given:** The runtime package is created
- **When:** Workspace dependencies are installed
- **Then:** The Mastra workflow dependency is available to `@seqlane/runtime`, `@seqlane/core` has no Mastra dependency, and workspace install, typecheck, test, lint, build, and format checks succeed

## Technical Details
spec.mastra-runtime-integration assigns the Mastra dependency to `@seqlane/runtime` and restricts imports to the workflow surface required by the compiler, conceptually `createStep` and `createWorkflow`. The core package must remain Mastra-independent.

## Out of Scope
- Implementing the compiler or runner behavior covered by the following stories
- Adding a deployable service, HTTP server, Terraform, or service-kit dependency
- Adding persistence, OpenCode integration, or production deployment configuration

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)
- [adr.mastra-internal-workflow-engine — Use Mastra as Seqlane’s Internal Workflow Engine](../adrs/2026-09-02-mastra-internal-workflow-engine.md)

## Traceability

- [spec.mastra-runtime-integration](../specs/2026-09-02-mastra-runtime-integration.md)
