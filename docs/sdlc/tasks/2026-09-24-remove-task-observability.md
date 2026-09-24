---
id: task.remove-task-observability
title: Remove Task Observability Configuration
status: completed
owners:
  - core
created: 2026-09-24
updated: 2026-09-24
upstream:
  - spec.mastra-runtime-and-operational-integration
  - spec.run-terminal-rendering
supersedes: []
---

# Remove Task Observability Configuration

## Objective

Remove the task `observability` field and use full JSON display values.

## Upstream requirements

Implement `requirement-task-display-values` in the runtime integration spec.

## Scope

Remove task metadata types, classifier forwarding, runtime selections and truncation, and
workflow configuration. Project complete task values in the TUI and CI output,
bound event-queue bytes with run failure on overflow, and update display and
lifecycle tests and documentation.

## Out of scope

Adapter observability context, Mastra tracing, and serialized event schemas.

## Implementation plan

Remove the field and selection path, verify lifecycle events and full display values,
then check all task factories and workflow consumers with TypeScript.

## Affected areas

Core task definitions, runtime value events, runner delivery, terminal
projections, and workflow declarations.

## Verification

Run test mapping, core, runtime, TUI, and CLI tests, TypeScript checks,
formatting, public documentation build, and SDLC validation.

## Completion criteria

Task types expose no observability field. Full JSON values reach the TUI, CI,
and recording sinks without task-level filtering or truncation. The event bridge
fails on queue overflow and drains previously accepted events. Lifecycle
ordering and JSON validation remain intact.

## Outcome

Approved PR findings 001–005 are implemented. Task input, result, and activity
values reach the human and CI TUI projections and local recordings without
task-level filtering or truncation. The runner limits queued and in-flight
event bytes to 16 MiB and drains accepted events before failing on overflow.

Test mapping passes (320 mappings). The full CLI, TUI, and runtime suites pass
under Node 24: 131, 125, and 429 tests. Repository typechecking, SDLC
validation (368 documents), and the public documentation build pass. The TUI
README, CLI run guide, and active specs describe the observability behavior and
its local-data risk.

## Delivery state

Open PR [#167](https://github.com/marcolink/seqlane/pull/167) on
`fix/remove-task-observability`; not yet merged to the default branch.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md#requirement-task-display-values)
- [spec.run-terminal-rendering](../specs/2026-09-15-run-terminal-rendering.md#requirement-human-details)
