# TS-021-01 — Validate Combined Checkpoint Dependency Graphs

**Status:** completed

## User outcome

As a workflow author, session dependencies run in the correct order and invalid
continuations fail before execution.

## Scope

- Infer reuse/branch dependency edges in the builder.
- Validate source type, source existence, combined-edge cycles, and one reuse
  consumer per checkpoint.
- Report involved nodes and edge kinds in validation errors.

## Out of scope

Checkpoint materialization or session-lock admission.

## Implementation notes

Use the existing Plan validation path as the canonical serialized-contract
boundary; do not create a parallel graph.

## Acceptance criteria

**Scenario:** *Session edge closes a cycle*

- **Given:** explicit and dataflow edges plus a session edge form a cycle
- **When:** the Plan is validated
- **Then:** validation rejects it before execution and identifies the edges

**Scenario:** *Duplicate reuse*

- **Given:** two tasks reuse one checkpoint
- **When:** the Plan is validated
- **Then:** validation rejects the duplicate consumers

## Source

- [ADR-021](../../ADR-021-session-checkpoint-reuse-and-branching.md)
- [TS-021](../../TS-021-session-checkpoint-reuse-and-branching.md)
