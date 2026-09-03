---
id: task.model-preflight
title: Add Executor Model Capabilities and Runtime Preflight
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.model-selection-and-session-model-semantics
supersedes: []
---

# Add Executor Model Capabilities and Runtime Preflight

> Migrated from implementation story `TS-022-03`.

## User outcome

As an operator, unavailable requested models fail before any task starts with
the executor name and useful alternatives.

## Scope

- Add normalized private executor model discovery/default capabilities.
- Collect distinct required selections from a compiled Plan.
- Resolve omitted models for new sessions through the executor default.
- Validate availability before scheduling invocations.
- Add deterministic fake-executor preflight tests.
- Preflight task-backed validation sessions as new sessions.
- Validate repeat-body model requirements without emitting static effective
  selection keys for runtime-created iterations.

## Out of scope

OpenCode HTTP details, session fork ordering, automatic fallback, pricing, and
per-iteration model/session pinning for repeat bodies (task.session-model-pinning).

## Acceptance criteria

**Scenario:** *Unavailable model*

- **Given:** a Plan requiring a model absent from the executor catalog
- **When:** runtime preflight runs
- **Then:** it fails before the first task and names requested and available
  models

**Scenario:** *Executor default*

- **Given:** a new session without an explicit model
- **When:** preflight resolves it
- **Then:** the executor default becomes the recorded effective selection

## Source

- [adr.model-selection-and-session-model-semantics](../adrs/2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)

## Traceability

- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)
