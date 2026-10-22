---
id: task.execute-project-events
title: Execute the workflow and project structured events through the CLI
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Execute the workflow and project structured events through the CLI

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-002-03`.

## Use Case

**As a** workflow operator, **I want to** see Seqlane lifecycle progress while the child executes the workflow, **so that** CLI output reflects authoritative structured runtime state.

## Acceptance Criteria

**Scenario:** _Successful execution is projected to the terminal_

- **Given:** The runner has loaded a valid workflow and the private runtime can execute it
- **When:** The workflow runs through the child boundary
- **Then:** Invocation and run events are forwarded over IPC, rendered by the CLI, and the final Seqlane output is returned without exposing runtime-engine types

**Scenario:** _Failure stops the projected run_

- **Given:** An invocation fails inside the runner
- **When:** The runtime reports the failure
- **Then:** The CLI receives the invocation and run failure events, does not render downstream work as successful, and preserves the normalized Seqlane error

## Technical Details

The runner maps in-process runtime events to `RunnerEvent`. The CLI renders events and does not parse runner logs or executor transcripts to infer status.

## Out of Scope

- Persistent event storage
- A local visual inspector
- Full OpenCode traces, OTEL, or runtime inspection UI
- Parallel or interactive workflow execution

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [spec.effect-v4-execution-and-operations: Effect v4 Execution and Operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
