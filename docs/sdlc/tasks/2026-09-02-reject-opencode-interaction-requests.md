---
id: task.reject-opencode-interaction-requests
title: Reject OpenCode interaction requests
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.autonomous-non-interactive-execution
supersedes: []
---

# Reject OpenCode interaction requests

> Migrated from implementation story `TS-005-03`.

## Use Case

**As a** Seqlane operator, **I want to** fail an OpenCode task that needs interaction, **so that** the external agent cannot block a V1 workflow waiting for a person.

## Scope

- Detect every interaction signal supported by the selected OpenCode SDK/server contract.
- Convert an OpenCode permission, question, confirmation, or selection requirement to `InteractionRequiredError`.
- Discard raw OpenCode interaction payloads before the error reaches the runtime.
- Confirm that the adapter makes no OpenCode permission-response, question-response, TUI, or user-input API call.
- Use the task.cancel-runner-preparation setup cancellation signal when the adapter creates an external session.

## Out of Scope

- OpenCode policy configuration, automatic approval, or a Seqlane permission profile.
- New OpenCode session modes, managed server lifecycle, or session deletion.
- Full OpenCode event persistence or a debugger UI.

## Implementation Notes

The adapter can only classify interaction states that the supported public server contract exposes. If a server version cannot report a required interaction deterministically, it is not compatible with this MVP path. Existing session abort remains cancellation behavior and does not become an interaction response.

## Acceptance Criteria

**Scenario:** *OpenCode interaction becomes Seqlane failure*
- **Given:** The fake OpenCode server returns a supported permission, question, confirmation, or selection requirement
- **When:** The adapter processes the task result
- **Then:** It throws `InteractionRequiredError` without raw OpenCode data and sends no response API request

**Scenario:** *OpenCode setup observes cancellation*
- **Given:** The adapter is creating a Run session and receives the runner setup signal
- **When:** The signal is aborted
- **Then:** The adapter creates no later task prompt and the runner reports one cancellation terminal event

**Scenario:** *The external server stays externally owned*
- **Given:** An interaction failure or cancellation
- **When:** The adapter finishes the Run path
- **Then:** It does not stop the external server, delete a session, or attach to an existing session

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.opencode-executor-integration — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [adr.autonomous-non-interactive-execution — Make V1 Workflow Execution Autonomous and Non-Interactive](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [spec.autonomous-non-interactive-execution — Autonomous Non-Interactive Execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
- [MVP — Autonomous Non-Interactive Execution](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
