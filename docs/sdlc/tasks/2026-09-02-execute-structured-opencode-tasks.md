---
id: task.execute-structured-opencode-tasks
title: Execute structured OpenCode tasks
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.opencode-executor-integration
supersedes: []
---

# Execute structured OpenCode tasks

> Migrated from implementation story `TS-004-03`.

## Use Case

**As a** workflow author, **I want to** receive a validated structured result from each OpenCode task, **so that** downstream Seqlane dataflow uses typed values instead of agent transcripts.

## Scope

- Implement the OpenCode `SeqlaneExecutor` adapter for in-memory OpenCode task definitions.
- Build an objective from validated Seqlane input.
- Add task instructions and textual references without replacing the repository harness.
- Send one schema-backed structured request through the Run session.
- Extract only the structured value from the OpenCode response.
- Return the raw value to the existing spec.mastra-runtime-integration Seqlane output-validation boundary.

## Out of Scope

- Conversation transcript persistence, event streaming, checkpoints, or forks.
- Parsing JSON from assistant prose.
- Tool, plugin, skill, MCP, model, provider, or agent replacement.
- Retries or concurrent OpenCode calls.

## Implementation Notes

The runtime has already resolved and validated task input before `execute()`. The adapter must use the task output schema provider from task.define-typed-opencode-tasks to request structured output. The runtime output schema validates the returned value again. The adapter must treat missing, malformed, or text-only output as an executor error.

## Acceptance Criteria

**Scenario:** *A task sends additive context through one session*
- **Given:** A validated OpenCode task input, objective, instructions, references, and an active Run session
- **When:** The executor runs the task
- **Then:** It sends one schema-backed task request to that session without parsing or replacing repository harness configuration

**Scenario:** *Only structured output enters Seqlane dataflow*
- **Given:** OpenCode returns a structured result with assistant text, tool data, or shell output
- **When:** The executor completes
- **Then:** It returns only the structured result and the spec.mastra-runtime-integration output schema independently validates it

**Scenario:** *Bad structured output stops the invocation*
- **Given:** OpenCode returns no structured result or a value that fails the task output schema
- **When:** The runtime processes the result
- **Then:** It emits the existing invocation failure path and no downstream task starts

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.opencode-executor-integration — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [MVP — Runtime Validation](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md)
