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
supersedes: []
---

# Remove Task Observability Configuration

## Objective

Remove the task `observability` field and use full JSON display values.

## Upstream requirements

Implement `requirement-task-display-values` in the runtime integration spec.

## Scope

Remove task metadata types, classifier forwarding, runtime selections and truncation, and
workflow configuration. Update display and lifecycle tests and the core README.

## Out of scope

Adapter observability context, Mastra tracing, and serialized event schemas.

## Implementation plan

Remove the field and selection path, verify lifecycle events and full display values,
then check all task factories and workflow consumers with TypeScript.

## Affected areas

Core task definitions, runtime value events, and workflow declarations.

## Verification

Run test mapping, core and focused runtime tests, TypeScript checks, formatting,
and SDLC validation.

## Completion criteria

Task types expose no observability field. Full JSON values retain all fields
without truncation. Lifecycle ordering and JSON validation remain intact.

## Outcome

Local implementation complete. All 96 core tests and 32 focused runtime tests
pass. Test mapping and repository TypeScript checks pass. The event bridge
preserves full validation evidence above the former 32 KiB limit.

## Delivery state

Working tree only. No commit or default-branch delivery is claimed.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md#requirement-task-display-values)
