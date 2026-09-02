# TS-022-04 — Pin Effective Selections Across Runtime Sessions

**Status:** planned

## User outcome

As a workflow author, reuse inherits one model and branches can start a new
model-pinned session without changing the parent.

## Scope

- Carry effective model selection in private resolved session state.
- Resolve isolated, reuse, branch, and child session inheritance.
- Reject mid-session model mutation even if the adapter supports it.
- Preserve serialized session/workspace admission and poisoning behavior.
- Add lifecycle tests for inheritance, forks, and child sessions.

## Out of scope

Executor catalog discovery implementation, OpenCode HTTP mapping, and event
rendering.

## Acceptance criteria

**Scenario:** *Reuse inherits*

- **Given:** a source session resolved to `anthropic/claude-sonnet-4-6`
- **When:** a continuation reuses its checkpoint without a model
- **Then:** it uses the same effective selection

**Scenario:** *Branch changes model*

- **Given:** a parent session with one pinned model
- **When:** a branch selects another available model
- **Then:** the parent remains unchanged and the branch is pinned to the new
  selection

## Source

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
