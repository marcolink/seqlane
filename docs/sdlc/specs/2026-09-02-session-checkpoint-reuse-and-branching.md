---
id: spec.session-checkpoint-reuse-and-branching
title: Session Checkpoint Reuse and Forking
status: active
owners:
  - core
created: 2026-09-02
updated: 2026-10-06
upstream:
  - adr.session-checkpoint-reuse-and-branching
supersedes: []
---

# Session Checkpoint Reuse and Forking

> Migrated from legacy technical specification `TS-021`.

## Public and Plan contract

`@seqlane/core` owns opaque checkpoint references and session helpers. An agent
invocation returns `{ nodeId, output, session }`; mechanical handles remain
output-only. A task invocation can select `{ type: "isolated" }`, `{ type:
"reuse", from }`, or `{ type: "fork", from }`. Task nodes serialize the
policy with the source node ID; default construction writes `isolated`.

The builder merges explicit dependencies, nested value references, and session
source references. Validation reports malformed checkpoint sources, duplicate
reuse consumers, incompatible source/target executor/runtime/workspace, and
cycles with task IDs and edge kinds.

## API contract

`fork(checkpoint, model?)` creates a separate session. Authoring policies, serialized
Plans, and protocol session snapshots use `type: "fork"`. The helper preserves the
source checkpoint and optional model selection. The owning schemas reject other
session-fork spellings and malformed policies, including in repeat attempts and
choice arms. One Plan type is used throughout authoring and execution.

Public session guides and examples show `fork`. Accepted ADRs, stable metadata
IDs, and historical document paths remain unchanged.

## Runtime contract

Checkpoint identity and executor sessions are private and scoped to one
`ExecutionContext`. A completed source publishes a checkpoint only after its
executor turn and all tracked effects terminate. Before publishing, the runtime
eagerly materializes every child via a capability-bearing executor
session resolver. Reuse resolves the parent session. Fork resolves the child
session created by native fork at the stored checkpoint.

Admission attempts session and workspace leases as one operation. It changes no
resource state unless both are available. Scheduling remains dependency-driven;
an orchestration/repeat node cannot retain a lease while it awaits children.
The lock registry retains FIFO/writer-preference behavior. Ambiguous termination
poisons the session and causes dependent reuse/fork work to fail causally.

## Adapter contract

The private OpenCode transport records the terminal message checkpoint and calls
`session.fork({ sessionID, messageID })`. It rejects missing fork capability or
an unconfirmed source state; it never starts an empty session or summarizes
history as a substitute.

## Verification

Tests use controlled fake sessions/barriers for default isolation, reuse,
eager forks, shared/exclusive workspace concurrency, no partial admission,
failure poisoning, combined-edge cycles, invalid checkpoint sources, and
OpenCode fork capability errors. Run:

```text
pnpm test:mapping
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm format:check
pnpm exec nx sync:check
git diff --check
```

## Traceability

- [adr.session-checkpoint-reuse-and-branching](../adrs/2026-09-02-session-checkpoint-reuse-and-branching.md)
