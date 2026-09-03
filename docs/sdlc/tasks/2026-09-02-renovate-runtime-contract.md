---
id: task.renovate-runtime-contract
title: Prove the MVP runtime with a Renovate-shaped workflow
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-integration
supersedes: []
---

# Prove the MVP runtime with a Renovate-shaped workflow

> Migrated from implementation story `TS-001-07`.

## Use Case
**As a** Seqlane maintainer, **I want to** verify a representative workflow through the real Mastra package, **so that** the MVP runtime contract is proven end to end before broader control-flow work begins.

## Acceptance Criteria
**Scenario:** *Representative workflow executes end to end*
- **Given:** A Renovate-shaped workflow contains `investigate → plan → fix → verify` and uses mocked OpenCode execution
- **When:** The runtime executes the workflow through the real Mastra package
- **Then:** The workflow completes in the expected order and returns a Seqlane-owned result

**Scenario:** *Representative failure behavior is verified*
- **Given:** A step in the Renovate-shaped workflow fails or is cancelled
- **When:** The integration test runs
- **Then:** Downstream execution stops or cancellation propagates to the fake executor as defined by the runtime contract

## Technical Details
The test suite includes compiler unit tests, runtime unit tests with a fake Executor, Mastra integration tests using the real package, and the Renovate-shaped contract fixture.

## Out of Scope
- Running against a real OpenCode server
- Deploying a Seqlane service
- Parallel, branching, looping, or durable workflow execution

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)

## Traceability

- [spec.mastra-runtime-integration](../specs/2026-09-02-mastra-runtime-integration.md)
