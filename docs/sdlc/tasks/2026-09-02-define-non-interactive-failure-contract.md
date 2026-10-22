---
id: task.define-non-interactive-failure-contract
title: Define the non-interactive failure contract
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.autonomous-non-interactive-execution
supersedes: []
---

# Define the non-interactive failure contract

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-005-00`.

## Use Case

**As a** Seqlane executor author, **I want to** report a required human decision through one safe Seqlane error contract, **so that** every executor fails consistently without creating an interaction channel.

## Scope

- Add the engine-independent `InteractionRequiredError` and its finite requirement kinds to `@seqlane/core`.
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

**Scenario:** _An executor has one safe interaction error_

- **Given:** An executor requires a permission, confirmation, question answer, or option selection
- **When:** It cannot continue autonomously
- **Then:** It can throw `InteractionRequiredError` with a finite requirement kind and a stable safe message

**Scenario:** _The runner protocol remains closed_

- **Given:** A command or event that contains an interaction response or an interaction request
- **When:** Core protocol validation runs
- **Then:** It rejects the message as invalid and accepts only the existing V1 command and event types

**Scenario:** _Core remains engine-independent_

- **Given:** The new error contract
- **When:** core package dependencies and exports are inspected
- **Then:** It contains no runtime-engine, OpenCode SDK, CLI, terminal, or Node process type

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.autonomous-non-interactive-execution — Make V1 Workflow Execution Autonomous and Non-Interactive](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.autonomous-non-interactive-execution — Autonomous Non-Interactive Execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
- [MVP — Autonomous Non-Interactive Execution](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)
