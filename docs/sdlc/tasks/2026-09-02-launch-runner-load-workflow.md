---
id: task.launch-runner-load-workflow
title: Launch a fresh runner and load the selected workflow inside it
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Launch a fresh runner and load the selected workflow inside it

> Migrated from implementation story `TS-002-02`.

## Use Case
**As a** workflow operator, **I want to** start a run from the CLI while the runner loads the workflow independently, **so that** the parent process remains a supervisor and every run has isolated runtime state.

## Acceptance Criteria
**Scenario:** *A selected workflow starts in a child process*
- **Given:** The CLI has a valid workflow reference and run input
- **When:** `seqlane run` is invoked
- **Then:** The CLI launches one foreground child with IPC, sends one `RunRequest`, and the child imports the workflow and emits `run.started`

**Scenario:** *Workflow loading failure is contained*
- **Given:** The runner cannot import or validate the selected workflow
- **When:** The child processes the run request
- **Then:** The runner emits a normalized `run.failed` event and exits without placing workflow execution state in the CLI

## Technical Details
The runner receives a module specifier and export name, not an executable workflow or Plan. It allocates the Run identity and performs execution-time loading after request validation.

## Out of Scope
- Building a persistent workflow registry
- Passing a compiled Plan from the CLI
- Running more than one request in a child process
- Background or detached execution

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [adr.dedicated-runner-process — Execute Each Seqlane Run in a Dedicated Node Process](../adrs/2026-09-02-dedicated-runner-process.md)
- [MVP — Dedicated Runner Process](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
