# TS-005-00 — Define the non-interactive failure contract

**Status:** completed

## Use Case

**As a** Seqlane executor author, **I want to** report a required human decision through one safe Seqlane error contract, **so that** every executor fails consistently without creating an interaction channel.

## Scope

- Add the Mastra-independent `InteractionRequiredError` and its finite requirement kinds to `@seqlane/core`.
- Define a stable error message that contains no raw executor interaction data.
- Document that the runtime converts this error to the existing `ExecutorError` failure path.
- Add strict protocol tests that reject user-input, confirmation, permission, option-selection, resume, and response command or event shapes.

## Out of Scope

- A new runner error category, command, or event.
- Runtime lifecycle changes.
- OpenCode-specific detection or cancellation changes.
- User prompts, approval, or response handling.

## Implementation Notes

The error is an executor-boundary signal, not a serialized protocol type. Keep the requirement kind finite and use it only to create safe Seqlane-owned messages. Do not retain raw OpenCode or future executor objects as its cause.

## Acceptance Criteria

**Scenario:** *An executor has one safe interaction error*
- **Given:** An executor requires a permission, confirmation, question answer, or option selection
- **When:** It cannot continue autonomously
- **Then:** It can throw `InteractionRequiredError` with a finite requirement kind and a stable safe message

**Scenario:** *The runner protocol remains closed*
- **Given:** A command or event that contains an interaction response or an interaction request
- **When:** Core protocol validation runs
- **Then:** It rejects the message as invalid and accepts only the existing V1 command and event types

**Scenario:** *Core remains engine-independent*
- **Given:** The new error contract
- **When:** core package dependencies and exports are inspected
- **Then:** It contains no Mastra, OpenCode SDK, CLI, terminal, or Node process type

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-005 — Make V1 Workflow Execution Autonomous and Non-Interactive](../../ADR-005-autonomous-non-interactive-execution.md)
- [TS-005 — Autonomous Non-Interactive Execution](../../TS-005-autonomous-non-interactive-execution.md)
- [MVP — Autonomous Non-Interactive Execution](../../MVP.md)
