# TS-005-02 — Map interaction requirements to task failure

**Status:** completed

## Use Case

**As a** Seqlane operator, **I want to** receive normal task and Run failures when an executor needs a human decision, **so that** workflows stop deterministically instead of waiting for input.

## Scope

- Recognize `InteractionRequiredError` in the TS-001 executor failure path.
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

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-005 — Make V1 Workflow Execution Autonomous and Non-Interactive](../../ADR-005-autonomous-non-interactive-execution.md)
- [TS-005 — Autonomous Non-Interactive Execution](../../TS-005-autonomous-non-interactive-execution.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
- [MVP — Failure and Retry Behavior](../../MVP.md)
