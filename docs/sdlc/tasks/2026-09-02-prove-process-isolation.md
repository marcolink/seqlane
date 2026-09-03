---
id: task.prove-process-isolation
title: Prove autonomous execution and per-run process isolation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Prove autonomous execution and per-run process isolation

> Migrated from implementation story `TS-002-06`.

## Use Case
**As a** Seqlane maintainer, **I want to** prove that runs are autonomous and isolated, **so that** one workflow cannot inherit runtime state or require CLI decisions from another.

## Acceptance Criteria
**Scenario:** *A run completes without CLI participation*
- **Given:** A valid workflow and an autonomous OpenCode policy
- **When:** The runner receives `RunRequest`
- **Then:** The workflow reaches success or failure without user-input, confirmation, permission, or branch-decision messages

**Scenario:** *Independent runs do not share state*
- **Given:** The same workflow is run twice
- **When:** Both invocations complete sequentially
- **Then:** Each run uses a distinct child and Run identity, and no executor, session, result, or cancellation state is reused

## Technical Details
Execution context, Mastra objects, executor instances, OpenCode handles, results, and cancellation state are created in the child and become unreachable when it exits.

## Out of Scope
- Cross-run Work continuation
- Persistent Run Records
- Detached/background execution
- Concurrent task scheduling

## Source
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [MVP — Autonomous Non-Interactive Execution](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
