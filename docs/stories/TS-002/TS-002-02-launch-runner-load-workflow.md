# TS-002-02 — Launch a fresh runner and load the selected workflow inside it

**Status:** completed


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
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [ADR-002 — Execute Each Seqlane Run in a Dedicated Node Process](../../ADR-002-dedicated-runner-process.md)
- [MVP — Dedicated Runner Process](../../MVP.md)
