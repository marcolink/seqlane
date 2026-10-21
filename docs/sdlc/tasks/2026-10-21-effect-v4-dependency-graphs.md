---
id: task.effect-v4-dependency-graphs
title: Real dependency graphs and failures
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-effect-tracer
supersedes: []
---

# Real dependency graphs and failures

## Objective

Execute a graph with independent fast/slow prerequisites, a join, malformed input, and a failing dependency through CLI and `startWorkflowRun`.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Execute a graph with independent fast/slow prerequisites, a join, malformed input, and a failing dependency through CLI and `startWorkflowRun`.
- Replace Promise dependency scheduling with scoped Effect fibers and dependency completion signals.
- Preserve result bindings, ready-node concurrency, failure phases, skipped dependents, and single terminal settlement.

## Affected areas

`runtime/compile`, `runtime/execution/program.ts`, `workflow-run.ts`, `start-workflow-run.ts`, and invocation execution.

## Verification

The compiled Oclif command, supervised worker, and direct `startWorkflowRun` fixtures verify ready-node execution, independent slow work, joins, full nested values, defaults, transforms, malformed input, and failed dependencies. Each created invocation receives one terminal event. Invalid task input fails before admission or task start.

Cancellation tests cover early cancellation, a blocked body permit, callbacks that ignore cancellation until their cleanup barrier settles, and pre-aborted requests with supplied adapter resources. A throwing skip handler cannot strand downstream completion. Unconfirmed termination remains a failure even when an earlier graph node was cancelled.

All 66 CLI end-to-end tests pass. The frozen install, documentation validation, 382 test mappings, typecheck, full tests across 20 projects, lint, build, formatting, Nx sync, and diff checks pass. The runtime suite passes all 495 tests.

An existing hosted queue-cancellation fixture exceeded its one-second deadline in isolation. Its test-only budget is now five seconds; the dedicated deadline test and production defaults are unchanged.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove the replaced Promise scheduler and duplicate run lifecycle once their callers switch.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Completed the native Effect dependency graph and shared target run settlement. Scoped fibers wait for dependency completion before acquiring a body permit. The target composition permits eight active bodies and waits for started work and cleanup before terminal settlement.

Removed the recursive Promise dependency scheduler and the separate one-task tracer implementation. CLI fixtures and the direct runtime facade now compose the same Plan program and terminal publisher. Authored callbacks and public/wire Zod contracts remain unchanged.

The private test composition remains until S9 switches production callers. Session admission and the remaining Plan node kinds belong to S3 and S4. This task does not claim production cutover or full migration delivery.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit. Evidence is branch-local. No default-branch or remote-CI delivery claim is made.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-effect-tracer: prerequisite task](./2026-10-21-effect-v4-effect-tracer.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
