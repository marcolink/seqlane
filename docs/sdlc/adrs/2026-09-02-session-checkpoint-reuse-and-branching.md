---
id: adr.session-checkpoint-reuse-and-branching
title: Reuse and Branch Run-Local Agent Sessions
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Reuse and Branch Run-Local Agent Sessions

## Decision

Agent task handles publish an immutable, opaque `SessionCheckpointRef` after a
successful invocation. Agent tasks accept `isolated()`, `reuse(checkpoint)`, or
`branch(checkpoint)` session selection; omission means `isolated()`.

The Plan IR serializes the selection with its source node address. Building a
Plan adds the associated dependency edge; validation evaluates one combined
graph of explicit, dataflow, and session edges. A checkpoint accepts one reuse
consumer and any number of branches.

At source completion, the runtime waits for all tracked activity, records a
stable checkpoint, eagerly creates every statically declared branch, then
publishes the source checkpoint and branch sessions. Reuse keeps the parent
runtime session; branch uses the executor's native checkpoint fork. A runtime
without exact native forking rejects branch workflows.

Session and workspace admission are atomic and independent. A ready invocation
holds neither resource while waiting for the other. Sessions and checkpoints
are Run-local. Failure after prompt acceptance, lost connection, timeout, or
unconfirmed cancellation poisons the session and prevents continuation/fork.

## Consequences

- Session history never merges; fan-in passes sibling outputs through normal
  typed input and explicitly selects one session.
- Shell and other mechanical task handles expose no session checkpoint.
- Executor identifiers, connections, and raw session/message IDs remain
  private runtime and adapter data.
- Native OpenCode `session.fork` is the initial adapter implementation.

## Out of scope

Session merge/rebase, cross-Run persistence, summaries as branch emulation,
workspace snapshots/worktrees, permission policy, and parallel prompts on one
runtime session.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
