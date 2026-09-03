---
id: task.forward-cancellation
title: Forward operating-system cancellation through the runner
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Forward operating-system cancellation through the runner

> Migrated from implementation story `TS-002-05`.

## Use Case
**As a** workflow operator, **I want to** stop an active run with Ctrl+C or termination, **so that** Seqlane cancels executor work cleanly without terminating the external OpenCode server.

## Acceptance Criteria
**Scenario:** *SIGINT forwards graceful cancellation*
- **Given:** A runner is executing a workflow and the CLI receives SIGINT
- **When:** The CLI handles the signal
- **Then:** It sends one `run.cancel` command, the runner propagates abort to the active executor, emits `run.cancelled`, and the CLI exits `130`

**Scenario:** *Cancellation has a bounded fallback*
- **Given:** The runner does not complete graceful cancellation within the configured grace period
- **When:** The CLI finishes the cancellation wait
- **Then:** It terminates the child, exits `130`, and does not send a stop or termination command to the externally owned OpenCode server

## Technical Details
The path is `SIGINT/SIGTERM → CLI → CancelRun → runner AbortController → Mastra cancellation → Executor/OpenCode abort`. Repeated signals are ignored while cancellation is pending.

## Out of Scope
- Suspend/resume
- Human approval or permission interaction
- Cancelling a persistent or remote runner
- Managing the lifecycle of an OpenCode server

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)
- [MVP — Cancellation](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
