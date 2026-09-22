---
id: task.agent-task-execution-deadline
title: Add Task-Level Agent Execution Deadlines
status: in-progress
owners:
  - core
created: 2026-09-22
updated: 2026-09-22
upstream:
  - spec.agent-adapter-boundary-and-capabilities
  - spec.mastra-backed-seqlane-workflows
  - spec.codex-app-server-adapter
supersedes: []
---

# Add Task-Level Agent Execution Deadlines

## Objective

Give every agent task a two-minute execution deadline and let authors override
it per task without adapter-specific configuration.

## Upstream requirements

- [requirement-agent-task-execution-deadline](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md#requirement-agent-task-execution-deadline)
- [REQ-TASK-001](../specs/2026-09-08-mastra-backed-seqlane-workflows.md#req-task-001-use-one-executable-task-contract)

## Scope

- Add validated `timeoutMs` to `defineAgentTask`.
- Start one runtime-owned deadline when an adapter begins external execution.
- Remove the Codex adapter execution timeout while retaining bounded cleanup.
- Document the default and override behavior.
- Set the Git diff example shell timeout to 30 seconds.

## Out of scope

- Adapter configuration, Plan, runner IPC, or CLI timeout settings.
- Changes to the existing shell-task timeout API.
- Automatic retries after a timeout.

## Implementation plan

1. Define the public task option and default in core.
2. Give adapters one execution-start callback and compose the armed deadline
   with runtime cancellation.
3. Make Codex, OpenCode, and ACP report execution start after private queueing.
4. Add contract, queueing, and timeout tests.
5. Update public and canonical documentation.

## Affected areas

`libs/core`, `libs/runtime`, concrete adapters, workflow examples, and
authoring documentation.

## Verification

Run mapping, focused core/runtime/Codex tests, typecheck, formatting, docs
index and validation, public-doc build, and the quality delta check.

## Completion criteria

- Default and override reach every selected adapter through one runtime signal
  armed after adapter queueing.
- No adapter owns an execution default.
- Timeout cleanup preserves uncertain-termination protection.
- Shell tasks can retain explicit shorter limits.

## Outcome

Implementation is in progress in [PR #146](https://github.com/marcolink/seqlane/pull/146).
The runtime now arms the task deadline only after the selected adapter reports
external execution start.

## Delivery state

No target-branch delivery evidence recorded yet.

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.codex-app-server-adapter](../specs/2026-09-12-codex-app-server-adapter.md)
