# TS-002-00 — Establish the CLI and runner package boundary

**Status:** completed


## Use Case
**As a** Seqlane maintainer, **I want to** establish the CLI supervisor and runtime runner entry points, **so that** process-boundary work has explicit package ownership and the CLI cannot depend on Mastra.

## Acceptance Criteria
**Scenario:** *CLI and runner entry points exist*
- **Given:** The repository has the core and runtime packages from TS-001
- **When:** The runner boundary is bootstrapped
- **Then:** A Seqlane CLI package owns oclif-facing behavior and the runtime package exposes a child-process runner entry point

**Scenario:** *Execution dependencies remain private*
- **Given:** The CLI and runner packages are available
- **When:** Workspace dependencies are installed and packages are typechecked
- **Then:** Mastra remains available only to the runtime package, the CLI has no Mastra dependency, and the existing workspace checks pass

## Technical Details
The CLI owns command parsing, discovery, launching, rendering, signals, and exit status. The runtime owns workflow loading, Plan execution, executor state, and cancellation. The CLI must live under `apps/` while remaining a private library package for Nx catalog purposes.

## Out of Scope
- Defining the IPC message contract
- Implementing workflow execution or OpenCode integration
- Adding a service, daemon, Terraform, persistence, or deployment infrastructure

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [ADR-002 — Execute Each Seqlane Run in a Dedicated Node Process](../../ADR-002-dedicated-runner-process.md)
