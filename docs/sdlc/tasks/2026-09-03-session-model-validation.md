---
id: task.session-model-validation
title: Validate Model Inheritance and Session Conflicts
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.model-selection-and-session-model-semantics
supersedes: []
---

# Validate Model Inheritance and Session Conflicts

> Migrated from implementation story `TS-022-02`.

## User outcome

As a workflow author, conflicting model declarations on one logical session
fail before execution with an actionable branch recommendation.

## Scope

- Extend Plan validation with model-selection shape and equality checks.
- Compare provider and model ID, plus reasoning when session semantics require
  it.
- Accept omitted continuation selections, which inherit the source.
- Validate branch inheritance and explicit branch changes.
- Reject any model selection nested under a reuse policy.
- Add malformed-input and conflict regression tests.

## Out of scope

Live executor catalogs, default resolution, session locks, and OpenCode calls.

## Acceptance criteria

**Scenario:** *Conflicting continuation*

- **Given:** a session pinned to `openai/gpt-5.6-luna`
- **When:** a continuation selects `openai/gpt-5.6-sol`
- **Then:** validation fails before execution and recommends a branch/isolated
  session

**Scenario:** *Reuse inherits*

- **Given:** a session pinned to `openai/gpt-5.6-luna`
- **When:** a continuation uses `reuse(checkpoint)`
- **Then:** validation succeeds

**Scenario:** *Different branch*

- **Given:** a parent session with one effective model
- **When:** a branch selects another model
- **Then:** validation accepts the new logical session

## Source

- [adr.model-selection-and-session-model-semantics](../adrs/2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)

## Traceability

- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)
