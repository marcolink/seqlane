---
id: task.map-interaction-requirements-to-task-failure
title: Map interaction requirements to task failure
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.autonomous-non-interactive-execution
supersedes: []
---

# Map interaction requirements to task failure

> Migrated from implementation story `TS-005-02`.

## Use Case

**As a** Seqlane operator, **I want to** receive normal task and Run failures when an executor needs a human decision, **so that** workflows stop deterministically instead of waiting for input.

## Scope

- Recognize `InteractionRequiredError` in the spec.mastra-runtime-integration executor failure path.
- Convert it to the existing `ExecutorError` for the active task.
- Emit the existing `invocation.failed` event followed by one `run.failed` event.
- Stop all downstream work.
- Preserve safe error serialization through runner IPC and CLI exit status `1`.

## Out of Scope

- New lifecycle events or a new terminal outcome.
- Interaction approval, response routing, or CLI prompts.
- Cancellation behavior or OpenCode-specific signal detection.

## Implementation Notes

Keep this mapping in the Seqlane runtime. The executor sees its interaction requirement, but Mastra, runner IPC, and CLI see only Seqlane-owned failure values. Do not include an interaction payload in a Plan or result.

## Acceptance Criteria

**Scenario:** *Interaction failure stops the workflow*
- **Given:** A fake executor throws `InteractionRequiredError` for one invocation
- **When:** The compiled workflow runs
- **Then:** The runtime emits `invocation.failed` with `ExecutorError`, emits one `run.failed`, and starts no downstream invocation

**Scenario:** *The CLI reports failure, not cancellation*
- **Given:** A runner receives an interaction failure from an executor
- **When:** The CLI supervises the runner
- **Then:** It returns exit status `1` and never reports `run.cancelled`

**Scenario:** *No raw interaction data crosses the boundary*
- **Given:** The executor interaction error contains raw request or response details
- **When:** the runner serializes the Seqlane failure
- **Then:** The protocol error contains only the safe Seqlane category, message, and task ID

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.autonomous-non-interactive-execution — Make V1 Workflow Execution Autonomous and Non-Interactive](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.autonomous-non-interactive-execution — Autonomous Non-Interactive Execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)
- [MVP — Failure and Retry Behavior](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
