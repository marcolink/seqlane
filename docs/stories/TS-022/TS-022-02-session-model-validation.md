# TS-022-02 — Validate Model Inheritance and Session Conflicts

**Status:** planned

## User outcome

As a workflow author, conflicting model declarations on one logical session
fail before execution with an actionable branch recommendation.

## Scope

- Extend Plan validation with model-selection shape and equality checks.
- Compare provider and model ID, plus reasoning when session semantics require
  it.
- Accept omitted and equal continuation selections.
- Validate branch inheritance and explicit branch changes.
- Add malformed-input and conflict regression tests.

## Out of scope

Live executor catalogs, default resolution, session locks, and OpenCode calls.

## Acceptance criteria

**Scenario:** *Conflicting continuation*

- **Given:** a session pinned to `openai/gpt-5.6-luna`
- **When:** a continuation selects `openai/gpt-5.6-sol`
- **Then:** validation fails before execution and recommends a branch/isolated
  session

**Scenario:** *Equal continuation*

- **Given:** a session pinned to `openai/gpt-5.6-luna`
- **When:** a continuation repeats that selection
- **Then:** validation succeeds

**Scenario:** *Different branch*

- **Given:** a parent session with one effective model
- **When:** a branch selects another model
- **Then:** validation accepts the new logical session

## Source

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
