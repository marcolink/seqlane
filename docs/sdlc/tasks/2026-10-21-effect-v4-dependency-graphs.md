---
id: task.effect-v4-dependency-graphs
title: Real dependency graphs and failures
status: planned
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

meaningful DAG/concurrency/failure fixtures and identical protocol results at both entrypoints.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove the replaced Promise scheduler and duplicate run lifecycle once their callers switch.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Not started. This task owns the implementation and evidence described above.

## Delivery state

Planned. Completion requires implementation evidence and a reachable delivery commit or merged pull request on the target branch.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-effect-tracer: prerequisite task](./2026-10-21-effect-v4-effect-tracer.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
