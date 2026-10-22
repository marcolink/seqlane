---
id: task.effect-v4-optimize-transactional-admission
title: Transactional admission
status: completed
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-adapter-coordination
supersedes: []
---

# Transactional admission

## Objective

Remove duplicated infrastructure through the pinned Effect v4 APIs. Preserve supported behavior and observability.

## Upstream requirements

The active execution and operations spec owns all contracts. Oclif and public/wire Zod stay unchanged.

## Documentation impact

Classification: implementation-only.

- PRD, RFC, ADR and SPEC: no change; existing ownership and behavior apply.
- TASK: create this bounded follow-up after the completed migration.
- Nearby docs: update only changed private service or process descriptions.

## Scope

Use transactional state and native retry for coordination where it removes custom wakeups. Simplify byte queue coordination while retaining its domain byte accounting and acknowledgement semantics.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Concurrent nested invocations -> atomic session/workspace admission -> ordered release.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

libs/runtime/src/runtime/invocation; libs/runtime/src/runtime/session; libs/runtime/src/runtime/workspace; libs/runtime/src/runner/byte-bounded-event-queue.ts

## Verification

Prove creation order, writer preference, ancestor bypass, no partial acquisition, cancelled waiter removal, quarantine, byte bounds, FIFO, terminal ordering, send deadlines and drain acknowledgements.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

The local implementation uses immutable `TxRef` state for session holders,
workspace holders, and queued demand. One `Effect.tx` transaction checks
eligibility and acquires every requested resource. Native `txRetry` replaces
change listeners, notification Deferreds, and manual handoff polling. Pure
eligibility policy stays separate from Effect execution. Observation callbacks
run after transactions.

Native scopes register waiter cleanup before acquisition. Unique lease tokens
let cancellation remove a committed lease that loses its handoff race. Cleanup
retains quarantined ownership. Unrelated quarantined groups reserve no other
workspace or session.

The queue uses one native `Latch` for idle acknowledgement waits. It retains
native `Queue` storage, byte accounting, FIFO capacity demand, callback overflow
failure, send deadlines, and terminal ordering.

The tracer uses `executeTaskNodeEffect` with a shared session and workspace.
It cancels blocked work and tests cancellation during release. The next eligible
task completes, all leases release, and model calls remain zero.

Focused verification passed: test mapping (604 mappings), 132 tests across ten
admission, nested workflow, repeat, checkpoint, and queue suites, runtime
TypeScript build, changed-file ESLint, and the source runtime-boundary audit.
All ten repository gates passed: frozen install, docs validation, test mapping,
typecheck, tests, lint, build, formatting, Nx synchronization, and diff checks.
Evidence: `/private/tmp/seqlane-effect-v4-gates/opt-admission/results.json`.

Formatted production lines, including both new files:

| File                                    | Before | After |
| --------------------------------------- | -----: | ----: |
| `invocation/joint-admission.ts`         |    336 |   129 |
| `invocation/joint-admission-policy.ts`  |      0 |   183 |
| `invocation/transactional-admission.ts` |      0 |    59 |
| `session/session-lock.ts`               |    214 |   155 |
| `workspace/workspace-lock.ts`           |    376 |   231 |
| `runner/byte-bounded-event-queue.ts`    |    549 |   552 |
| Total                                   |   1475 |  1309 |

Paths are relative to `libs/runtime/src/runtime`, except the queue path, which
is relative to `libs/runtime/src`.

Retained native API gaps:

- Element capacity cannot express the queue's byte bound. Weighted semaphore
  admission does not establish FIFO demand across different byte counts.
- Native `Queue.flush` does not wait for sink acknowledgements. Explicit byte
  reservations remain held through delivery acknowledgements.
- Existing Promise task callbacks and synchronous lease APIs require private
  integration edges. Synchronous callbacks evaluate only pure state transactions;
  Effect callers retain their scope, interruption, and native transactional waits.

The Ripwire contract check reports unchanged joint registry construction and no
incompatible callers. Its quality delta flags historical churn and type-only
interfaces as dead code. The two domain cleanup methods retain their distinct
holder representations; no generic cleanup framework was added.

## Delivery state

Completed in this task commit on `feat/effect-v4-migration`. Final hosted CI
verification belongs to the policy clocks and final audit task. No
default-branch delivery claim.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-adapter-coordination](./2026-10-22-effect-v4-optimize-adapter-coordination.md)
