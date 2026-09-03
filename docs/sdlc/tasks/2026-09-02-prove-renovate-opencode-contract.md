---
id: task.prove-renovate-opencode-contract
title: Prove the Renovate OpenCode contract
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.opencode-executor-integration
supersedes: []
---

# Prove the Renovate OpenCode contract

> Migrated from implementation story `TS-004-06`.

## Use Case

**As a** Seqlane maintainer, **I want to** run the representative Renovate workflow through the OpenCode adapter contract, **so that** the MVP proves typed dataflow, one-session execution, validation, cancellation, and runner isolation together.

## Scope

- Define the Renovate fixture tasks through the public OpenCode task factory.
- Use the deterministic fake OpenCode server to return structured results for investigate, plan, fix, and verify.
- Assert one new session and four serialized requests for one Run.
- Assert that every result crosses Seqlane output validation before downstream input resolution.
- Cover a malformed result, OpenCode task failure, unresolved interaction, and active cancellation.
- Update package documentation that describes the supported OpenCode workflow path.

## Out of Scope

- A live model or a real external OpenCode server in automated tests.
- Actual Renovate remediation against an arbitrary repository.
- Discovery, persistence, replay, telemetry, or debugger features.

## Implementation Notes

The fake server is a deterministic contract boundary, not a fake executor. It must observe the public adapter requests, session use, abort request, and structured response handling. The fixture retains no SDK objects in core, runtime, CLI, or runner IPC.

## Acceptance Criteria

**Scenario:** *The representative workflow uses one session in order*
- **Given:** The Renovate-shaped `investigate → plan → fix → verify` workflow and the fake OpenCode server
- **When:** The CLI starts one Run
- **Then:** The server observes one new session and four sequential structured task requests in that session

**Scenario:** *Validated task outputs drive later tasks*
- **Given:** The fake server returns a valid structured result for each task
- **When:** The workflow executes
- **Then:** Each downstream request receives data derived from Seqlane-validated output, and the final CLI result has the expected shape

**Scenario:** *Failures retain the Seqlane boundary*
- **Given:** The fake server returns malformed output, a task error, unresolved interaction, or an active cancellation case
- **When:** The contract suite executes through the runner boundary
- **Then:** The Run has the correct existing terminal outcome, downstream work stops, and the external server remains available

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.opencode-executor-integration — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [MVP — Reference Use Case](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md)
