---
id: task.cli-runner-boundary
title: Establish the CLI and runner package boundary
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Establish the CLI and runner package boundary

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-002-00`.

## Use Case

**As a** Seqlane maintainer, **I want to** establish the CLI supervisor and runtime runner entry points, **so that** process-boundary work has explicit package ownership and the CLI cannot own runtime-engine state.

## Acceptance Criteria

**Scenario:** _CLI and runner entry points exist_

- **Given:** The repository has the core and runtime package boundaries
- **When:** The runner boundary is bootstrapped
- **Then:** A Seqlane CLI package owns oclif-facing behavior and the runtime package exposes a child-process runner entry point

**Scenario:** _Execution dependencies remain private_

- **Given:** The CLI and runner packages are available
- **When:** Workspace dependencies are installed and packages are typechecked
- **Then:** Execution dependencies remain available only to the runtime package, the CLI has no runtime-engine dependency, and the existing workspace checks pass

## Technical Details

The CLI owns command parsing, discovery, launching, rendering, signals, and exit status. The runtime owns workflow loading, Plan execution, executor state, and cancellation. The CLI must live under `apps/` while remaining a private library package for Nx catalog purposes.

## Out of Scope

- Defining the IPC message contract
- Implementing workflow execution or OpenCode integration
- Adding a service, daemon, Terraform, persistence, or deployment infrastructure

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [adr.dedicated-runner-process — Execute Each Seqlane Run in a Dedicated Node Process](../adrs/2026-09-02-dedicated-runner-process.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
