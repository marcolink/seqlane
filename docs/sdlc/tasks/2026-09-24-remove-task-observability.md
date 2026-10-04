---
id: task.remove-task-observability
title: Remove Task Observability Configuration
status: completed
owners:
  - core
created: 2026-09-24
updated: 2026-10-04
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

Task types expose no observability field. Canonical events and CI output carry
full JSON values without task-level filtering or truncation. Optional event
recordings preserve those events. The human TUI retains complete recent values
within a bounded projection and reports whole-record evictions. The event bridge
drains accepted events after queue overflow and reports terminal failure.
Lifecycle ordering and JSON validation remain intact.

## Outcome

The approved follow-up addresses findings 002/006, 005, and 009 from the
review of revision `b87143f5`. Human output includes retained activities with
only lifecycle fields. Operational-host runs settle accepted events, send
terminal failure outside a failed queue, and complete cleanup even when direct
delivery fails. CI prints complete observation events, including model request
and response values. Findings 003/007 remain an accepted full-observability
tradeoff; advisories 008 and 010 remain deferred.

Canonical task input, result, activity, and observation values reach CI output
and optional local recordings without task-level filtering or truncation. The human TUI retains complete
recent values within 16 MiB and 1,000 records, evicts oldest whole records,
and shows an eviction notice. The runner limits queued and in-flight events to
16 MiB, drains accepted events on failure, then sends a terminal failure
directly when IPC permits. CI status lines and complete JSON event lines use
their distinct documented formats.

Test mapping passes (320 mappings). The latest full CLI and TUI suites pass
under Node 24 (264 tests), with dependency and package builds passing. Earlier
full core and runtime suites passed. The public documentation build passes.
SDLC validation passes (370 documents). Repository `pnpm typecheck` fails on
three errors in `libs/action-code-review/src/pr-code-review-example.spec.ts`,
which is unchanged from `origin/main`. The TUI README, CLI run guide, and
active specs describe the observability behavior and its local-data risk.
Structural review flags added size and branches in the existing operational-host
orchestration. This follow-up keeps the recovery change scoped; broader
orchestration refactoring remains outside these approved fixes.

## Delivery state

Open PR [#167](https://github.com/marcolink/seqlane/pull/167) on
`fix/remove-task-observability`, rebased onto `origin/main` at `f7dc05e`; not
yet merged to the default branch.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md#requirement-task-display-values)
- [spec.run-terminal-rendering](../specs/2026-09-15-run-terminal-rendering.md#requirement-human-details)
