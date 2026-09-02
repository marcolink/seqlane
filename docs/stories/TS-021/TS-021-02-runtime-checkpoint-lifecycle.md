# TS-021-02 — Resolve and Publish Run-Local Session Checkpoints

**Status:** completed

## User outcome

As a workflow author, reuse continues the exact parent session and branches
start from its stable checkpoint.

## Scope

- Add private session/checkpoint capabilities to resolver adapters.
- Publish checkpoints after complete invocation activity only.
- Eagerly materialize all declared branches before parent continuation starts.
- Enforce Run locality, compatibility, single-session execution, and poisoning.

## Out of scope

Atomic workspace admission and adapter-specific HTTP calls.

## Implementation notes

Branch materialization is a post-turn lifecycle operation, not a scheduler task
and does not wait on the source invocation lease.

## Acceptance criteria

**Scenario:** *Eager fan-out*

- **Given:** one source with two declared branches and one parent reuse
- **When:** the source completes
- **Then:** both child sessions exist before parent reuse can advance

**Scenario:** *Ambiguous source*

- **Given:** a source with timeout, disconnect, or unconfirmed cancellation
- **When:** a consumer needs its checkpoint
- **Then:** it fails with the causal poisoned-session error

## Source

- [ADR-021](../../ADR-021-session-checkpoint-reuse-and-branching.md)
- [TS-021](../../TS-021-session-checkpoint-reuse-and-branching.md)
