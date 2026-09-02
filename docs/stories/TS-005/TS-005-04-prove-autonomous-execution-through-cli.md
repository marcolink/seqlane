# TS-005-04 — Prove autonomous execution through the CLI

**Status:** completed

## Use Case

**As a** Seqlane maintainer, **I want to** prove success, interaction failure, and cancellation through the CLI child boundary, **so that** the MVP has no hidden human-response path.

## Scope

- Run the Renovate-shaped OpenCode workflow through the real CLI and child runner.
- Use the deterministic fake OpenCode server for success, interaction, setup-cancellation, and active-cancellation cases.
- Assert that runner IPC contains only the existing command and event types.
- Assert that the CLI sends no task decision after `run.start`.
- Document the autonomous execution guarantee and the interaction-failure outcome near the supported OpenCode workflow documentation.

## Out of Scope

- A live model or real OpenCode server in automated tests.
- Interactive CLI UX, prompts, terminal reads, pause, or resume.
- Workflow discovery, persistence, replay, telemetry, or debugger features.

## Implementation Notes

The contract suite must start the CLI with valid input and then use only cancellation as a later control. It must inspect protocol messages rather than terminal text to prove the closed interaction boundary.

## Acceptance Criteria

**Scenario:** *A workflow completes without later decisions*
- **Given:** A valid Renovate-shaped workflow request and fake OpenCode server
- **When:** The CLI starts the Run
- **Then:** The workflow succeeds with the existing lifecycle events, and the CLI sends no command after `run.start`

**Scenario:** *Interaction has a deterministic terminal failure*
- **Given:** The fake server reports an unresolved interaction for one task
- **When:** The CLI runs the workflow
- **Then:** It reports `invocation.failed` and `run.failed`, exits with `1`, and sends no interaction response

**Scenario:** *Cancellation remains the only later control*
- **Given:** The fake server holds setup or active task work
- **When:** The CLI receives `SIGINT` or `SIGTERM`
- **Then:** It sends one `run.cancel`, exits with `130`, and the server receives no permission or user-response request

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-005 — Make V1 Workflow Execution Autonomous and Non-Interactive](../../ADR-005-autonomous-non-interactive-execution.md)
- [TS-005 — Autonomous Non-Interactive Execution](../../TS-005-autonomous-non-interactive-execution.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [TS-004 — OpenCode Executor Integration](../../TS-004-opencode-executor-integration.md)
- [MVP — Success Criteria](../../MVP.md)
