# TS-021-04 — Fork Native OpenCode Checkpoint Sessions and Document Use

**Status:** completed

## User outcome

As a workflow author, OpenCode branches retain exact source context and the API
documents safe fan-out/fan-in usage.

## Scope

- Record terminal OpenCode message checkpoints and use native `session.fork`.
- Reject missing native fork support with a capability error.
- Update core/runtime/OpenCode documentation and a complete fan-out/fan-in
  example.
- Run the complete verification gate and a docs-sync review.

## Out of scope

Session merge/rebase, cross-Run persistence, summaries, or worktrees.

## Implementation notes

The adapter must not expose OpenCode IDs across public or IPC boundaries.

## Acceptance criteria

**Scenario:** *Exact native fork*

- **Given:** a successful OpenCode source checkpoint
- **When:** a declared branch materializes
- **Then:** the adapter calls native fork with the source session and checkpoint

**Scenario:** *Fan-out/fan-in documentation*

- **Given:** an author reads package documentation
- **When:** they need parallel analysis followed by synthesis
- **Then:** they find a complete example and no implication of session merging

## Source

- [ADR-021](../../ADR-021-session-checkpoint-reuse-and-branching.md)
- [TS-021](../../TS-021-session-checkpoint-reuse-and-branching.md)
