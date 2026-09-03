# TS-022-05 — Initialize OpenCode Fork Models Before Prompting

**Status:** completed

## User outcome

As an OpenCode workflow author, a branched task never receives its first
prompt until the selected model and reasoning configuration succeed.

## Scope

- Map normalized model selections to OpenCode requests.
- Configure a fork after native checkpoint fork and before first prompt.
- Keep initialization atomic from Seqlane scheduler perspective.
- Add transport/adapter tests for ordering and configuration failure.

## Out of scope

Codex, other adapters, session merge, credential management, and fallback.

## Acceptance criteria

**Scenario:** *Fork configuration ordering*

- **Given:** a successful OpenCode checkpoint and changed branch selection
- **When:** the branch initializes
- **Then:** fork, configure, and first prompt occur in that order

**Scenario:** *Configuration failure*

- **Given:** OpenCode rejects the branch model configuration
- **When:** initialization runs
- **Then:** no first prompt is sent and the branch is not published as ready

## Source

- [ADR-022](../../ADR-022-model-selection-and-session-model-semantics.md)
- [TS-022](../../TS-022-model-selection-and-session-model-semantics.md)
