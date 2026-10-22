---
id: task.renovate-runtime-contract
title: Prove the MVP runtime with a Renovate-shaped workflow
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Prove the MVP runtime with a Renovate-shaped workflow

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-001-07`.

## Use Case

**As a** Seqlane maintainer, **I want to** verify a representative workflow through the runtime integration, **so that** the MVP runtime contract is proven end to end before broader control-flow work begins.

## Acceptance Criteria

**Scenario:** _Representative workflow executes end to end_

- **Given:** A Renovate-shaped workflow contains `investigate → plan → fix → verify` and uses mocked OpenCode execution
- **When:** The runtime executes the workflow through the runtime integration
- **Then:** The workflow completes in the expected order and returns a Seqlane-owned result

**Scenario:** _Representative failure behavior is verified_

- **Given:** A step in the Renovate-shaped workflow fails or is cancelled
- **When:** The integration test runs
- **Then:** Downstream execution stops or cancellation propagates to the fake executor as defined by the runtime contract

## Technical Details

The test suite includes compiler unit tests, runtime unit tests with a fake Executor, runtime integration tests, and the Renovate-shaped contract fixture.

## Out of Scope

- Running against a real OpenCode server
- Deploying a Seqlane service
- Parallel, branching, looping, or durable workflow execution

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
