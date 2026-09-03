---
id: task.validate-mvp-runner-contract
title: Validate the runner boundary with the MVP workflow contract
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Validate the runner boundary with the MVP workflow contract

> Migrated from implementation story `TS-002-07`.

## Use Case
**As a** Seqlane maintainer, **I want to** validate the complete child-process boundary with a representative workflow, **so that** the MVP proves isolated execution, event transport, failure handling, and cancellation together.

## Acceptance Criteria
**Scenario:** *Renovate-shaped workflow executes through the child*
- **Given:** The Renovate-shaped `investigate → plan → fix → verify` fixture and mocked OpenCode execution
- **When:** The CLI launches the runner and sends a `RunRequest`
- **Then:** The runner imports and executes the workflow through spec.mastra-runtime-integration, the CLI receives the expected event sequence, and the command returns the Seqlane-owned result

**Scenario:** *Boundary failure and cancellation are covered*
- **Given:** The fixture is configured for an invocation failure or active cancellation
- **When:** The child-boundary integration test runs
- **Then:** Downstream work stops or abort reaches the fake executor, the terminal event is correct, and all workspace quality checks pass

## Technical Details
The contract suite should use a real child process and fake executor/OpenCode adapter. It must verify JSON-only messages, one terminal event, fresh-process behavior, normalized errors, event rendering, and signal forwarding.

## Out of Scope
- A real OpenCode server in automated tests
- Production deployment or service orchestration
- Persistence, replay, OTEL, or a debugger UI

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)
- [MVP — Success Criteria](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
