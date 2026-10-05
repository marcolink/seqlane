---
id: spec.session-checkpoint-reuse-and-branching
title: Session Checkpoint Reuse and Forking
status: active
owners:
  - core
created: 2026-09-02
updated: 2026-10-05
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

## API compatibility

`fork(checkpoint, model?)` is the preferred helper. Deprecated `branch(checkpoint,
model?)` remains exported with its original arguments and returned `type: "branch"`
shape. Both authoring policy spellings are accepted. The builder emits canonical
`type: "fork"` policies, including when callers use the deprecated helper.

The canonical Plan schema accepts legacy `type: "branch"` policies and normalizes
them to `type: "fork"` before runtime validation and execution. It preserves the
source and optional model selection, rejects malformed policies, and also applies
inside repeat attempts. Protocol readers accept both spellings;
new run snapshots emit `fork`. No removal deadline is established.

Current public session guides and examples show only `fork`. Compatibility names
remain in this contract, API annotations, and regression tests. Accepted ADRs,
stable metadata IDs, and historical document paths remain unchanged.

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
