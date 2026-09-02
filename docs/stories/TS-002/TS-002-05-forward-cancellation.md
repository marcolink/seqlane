# TS-002-05 — Forward operating-system cancellation through the runner

**Status:** completed


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
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
- [MVP — Cancellation](../../MVP.md)
