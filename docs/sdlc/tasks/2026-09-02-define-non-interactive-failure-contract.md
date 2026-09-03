---
id: task.define-non-interactive-failure-contract
title: Define the non-interactive failure contract
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.autonomous-non-interactive-execution
supersedes: []
---

# Define the non-interactive failure contract

> Migrated from implementation story `TS-005-00`.

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

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.autonomous-non-interactive-execution — Make V1 Workflow Execution Autonomous and Non-Interactive](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.autonomous-non-interactive-execution — Autonomous Non-Interactive Execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
- [MVP — Autonomous Non-Interactive Execution](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
