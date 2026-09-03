---
id: task.propagate-cancellation-reject-interaction
title: Propagate cancellation and reject interaction
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.opencode-executor-integration
supersedes: []
---

# Propagate cancellation and reject interaction

> Migrated from implementation story `TS-004-05`.

## Use Case

**As a** Seqlane operator, **I want to** cancel active OpenCode work without an interactive permission path, **so that** a Run remains autonomous and does not own the external server.

## Scope

- Connect the existing executor `AbortSignal` to the supported OpenCode session-abort operation.
- Send at most one abort request for active OpenCode work.
- Prevent session creation when cancellation arrives before OpenCode setup completes.
- Convert unresolved OpenCode permission or interaction states into executor failures.
- Cover cancellation through the real CLI-to-runner path with the fake server.

## Out of Scope

- Automatic permission approval or a user-response protocol.
- Deleting the session or stopping the external server during cancellation.
- Retry, pause, resume, or durable execution.

## Implementation Notes

Use only public server signals that identify unresolved permission or interaction. If the selected server contract cannot report that condition deterministically, it is not an MVP-compatible contract. The adapter must never call an OpenCode TUI or permission-response API.

## Acceptance Criteria

**Scenario:** *Cancellation aborts the active OpenCode session once*
- **Given:** An active OpenCode task and a CLI cancellation signal
- **When:** The signal reaches the runner executor
- **Then:** The adapter sends one session-abort request, the Run emits `run.cancelled`, and Seqlane does not stop the server or delete the session

**Scenario:** *Early cancellation starts no task work*
- **Given:** Cancellation is accepted before session creation completes
- **When:** The adapter setup continues
- **Then:** It creates no session and sends no task request

**Scenario:** *Interaction fails instead of prompting*
- **Given:** The OpenCode server reports an unresolved permission or interaction requirement
- **When:** The adapter receives that state
- **Then:** The invocation fails through the Seqlane executor path, and Seqlane sends no approval, terminal input, or response message

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.opencode-executor-integration — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [MVP — Autonomous Non-Interactive Execution](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md)
