---
id: task.nested-workflow-workspace-admission
title: Make Nested Workflow Workspace Admission Safe
status: planned
owners:
  - core
created: 2026-09-11
updated: 2026-09-11
upstream:
  - task.compose-workflows-as-runnables
  - spec.mastra-backed-seqlane-workflows
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Make Nested Workflow Workspace Admission Safe

## Objective

Make workspace admission correct for nested Plans, repeat bodies, and
multi-level workflow execution. Resource discovery, ownership, policy
compatibility, and cancellation must use one consistent admission model.

## Upstream requirements

- `SEQ-PR99-007`: Aggregate every descendant workspace resource.
- `SEQ-PR99-010`: Preserve one canonical descendant workspace owner.
- `SEQ-PR99-011`: Prevent shared-parent and exclusive-descendant deadlocks.
- `SEQ-PR99-012`: Observe cancellation while admission is queued.
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Scope

- Build one recursive resource collector covering normal nodes, repeat bodies,
  nested workflows, validation tasks, and the default resource for unmapped
  definitions.
- Propagate a canonical descendant workspace owner through all nested levels.
- Preserve atomic, globally ordered admission across the complete resource set.
- Reject shared workflow admission when its descendant closure requires
  exclusive access, rather than attempting an unsafe lock upgrade.
- Pass abort signals into workspace acquisition and check cancellation after
  each lease grant; release partial leases on cancellation.
- Add regression tests for resource aggregation, three-level ownership,
  shared/exclusive policy combinations, and queued cancellation.

## Out of scope

- Changing the public workspace policy values.
- Replacing the existing session or DAG admission model.
- Adding a new workspace-lock implementation unrelated to nested execution.

## Implementation plan

1. Define the recursive resource and descendant-policy closure at the runtime
   boundary.
2. Thread canonical ownership and abort signals through nested admission.
3. Enforce the shared/exclusive compatibility rule before acquiring leases.
4. Add contention and cancellation tests, including partial-acquisition cleanup.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-runtime/`
- `libs/seqlane-fixtures/`

## Verification

Run `pnpm test:mapping` first. Then run focused runtime admission and nested
workflow tests, typechecks, builds, and cancellation checks.

## Completion criteria

- Every descendant resource is included exactly once in aggregate admission.
- Three-level nested execution cannot deadlock because ownership changes at a
  child boundary.
- Unsafe shared/exclusive compositions fail with a typed policy error.
- Queued cancellation completes without waiting for an unrelated lease release
  and without leaking partial leases.
- Existing workspace progress and terminal outcome contracts remain valid.

## Outcome

Not delivered. This task records follow-ups for `SEQ-PR99-007` and
`SEQ-PR99-010` through `SEQ-PR99-012`.

## Delivery state

Planned; no implementation or delivery evidence claimed.

## Traceability

- [task.compose-workflows-as-runnables: Compose Workflows as Runnables](./2026-09-08-compose-workflows-as-runnables.md)
- [spec.invocation-admission-and-workspace-coordination: Invocation Admission and Workspace Coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
