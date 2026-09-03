---
id: task.cancel-runner-preparation
title: Cancel runner preparation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.autonomous-non-interactive-execution
supersedes: []
---

# Cancel runner preparation

> Migrated from implementation story `TS-005-01`.

## Use Case

**As a** Seqlane operator, **I want to** cancel a Run while the runner prepares execution, **so that** cancellation prevents later external session or task work.

## Scope

- Create a run-scoped `AbortController` before runner preparation starts.
- Pass its signal to the runner-execution factory as an added final argument.
- Abort the controller when the runner receives `run.cancel`.
- Pass the setup signal to OpenCode session creation and other setup work that creates external state.
- Preserve compatibility with existing two-argument runner-execution factories.
- Emit exactly one `run.cancelled` event when cancellation prevents execution.

## Out of Scope

- Cancellation after active task execution begins.
- New IPC commands or event fields.
- Deleting an OpenCode session or stopping an external server.
- Retry, pause, resume, or persistence.

## Implementation Notes

The runner must make the same controller visible to setup and active execution. A cancellation during workflow import cannot interrupt JavaScript module evaluation, but it must prevent all later factory, session, compilation, and task work that observes the signal.

## Acceptance Criteria

**Scenario:** *Early cancellation creates no external session*
- **Given:** The CLI sends `run.cancel` before the runner begins OpenCode session setup
- **When:** The runner continues its setup path
- **Then:** It creates no session, starts no invocation, and emits one `run.cancelled` event

**Scenario:** *Setup cancellation reaches the OpenCode factory*
- **Given:** An OpenCode runner-execution factory waits while it creates a session
- **When:** The runner accepts cancellation
- **Then:** The factory receives an aborted signal, submits no task prompt, and the runner reports cancellation

**Scenario:** *Existing factories remain valid*
- **Given:** An existing fixture that exports a two-argument runner-execution factory
- **When:** The runner starts that fixture
- **Then:** It retains its current execution behavior without a source import change

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.autonomous-non-interactive-execution — Make V1 Workflow Execution Autonomous and Non-Interactive](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.autonomous-non-interactive-execution — Autonomous Non-Interactive Execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [MVP — Cancellation](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
