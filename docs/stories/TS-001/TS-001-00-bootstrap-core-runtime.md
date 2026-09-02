# TS-001-00 — Bootstrap the core and runtime packages for TS-001

**Status:** completed


## Use Case
**As a** Seqlane maintainer, **I want to** bootstrap the core and runtime package boundaries with only the dependencies required by TS-001, **so that** runtime work can begin without leaking Mastra into public contracts or adding service infrastructure.

## Acceptance Criteria
**Scenario:** *Core and runtime package boundaries exist*
- **Given:** The repository contains the foundation workspace
- **When:** The TS-001 bootstrap is completed
- **Then:** `@seqlane/core` owns public contracts and Plan IR, while `@seqlane/runtime` owns the runner and Mastra integration boundary

**Scenario:** *Required runtime dependencies are installed in the correct package*
- **Given:** The runtime package is created
- **When:** Workspace dependencies are installed
- **Then:** The Mastra workflow dependency is available to `@seqlane/runtime`, `@seqlane/core` has no Mastra dependency, and workspace install, typecheck, test, lint, build, and format checks succeed

## Technical Details
TS-001 assigns the Mastra dependency to `@seqlane/runtime` and restricts imports to the workflow surface required by the compiler, conceptually `createStep` and `createWorkflow`. The core package must remain Mastra-independent.

## Out of Scope
- Implementing the compiler or runner behavior covered by the following stories
- Adding a deployable service, HTTP server, Terraform, or service-kit dependency
- Adding persistence, OpenCode integration, or production deployment configuration

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
- [ADR-001 — Use Mastra as Seqlane’s Internal Workflow Engine](../../ADR-001-mastra-internal-workflow-engine.md)
