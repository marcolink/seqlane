# TS-022-03 — Add Executor Model Capabilities and Runtime Preflight

**Status:** completed

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
per-iteration model/session pinning for repeat bodies (TS-022-04).

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

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
